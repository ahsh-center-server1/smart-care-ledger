'use strict';

/**
 * 연도 마감 — 그 해 거래를 archive_YYYY 로 옮기고 기초잔액을 다음 해로 전진시킨다.
 *
 * 왜 서버로 옮겼나 (두 가지 이유가 겹쳤다)
 *   1. 마감은 **마감된 달의 거래를 지운다.** 규칙이 잠긴 달의 삭제를 막게 되면서
 *      브라우저에서 도는 마감은 그 자체로 거부된다. 센터장에게 lock.bypass 를
 *      주면 마감 말고도 다 열리므로 답이 아니다.
 *   2. 보관용 재압축이 최종 객체를 **덮어쓴다.** Web SDK 의 uploadBytes 에는
 *      generation 사전조건이 없어서, 같은 순간 다른 사람이 증빙을 교체하면
 *      그 교체가 조용히 뭉개진다.
 *
 * 왜 나눠서 도나
 *   한 해 거래가 수천 건이면 한 번의 호출로 끝나지 않는다. 그래서 단계와
 *   진행 상황을 config/archive_YYYY 에 적고, 호출할 때마다 정해진 만큼만 하고
 *   "아직 남았다"를 돌려준다. 화면은 끝날 때까지 다시 부른다.
 *
 *   모든 단계가 멱등하다 — 중단된 마감을 같은 연도로 다시 실행하면 이어서
 *   진행되고, 사본이 중복되지 않는다(사본의 문서 ID 가 원본 ID 다).
 *
 * 순서가 중요하다
 *   사본 저장 → 원본 삭제. 뒤집으면 중단 시 거래가 사라진다.
 *   기초잔액 전진은 원본을 다 옮긴 뒤에 한다 — 중간에 전진하면 남은 거래가
 *   두 번 계산된다.
 */

const { capName } = require('./perm-catalog.cjs');
const { randomUUID } = require('node:crypto');

const AUTHZ = 'authz';
const TRANSACTIONS = 'transactions';
const ACCOUNTS = 'accounts';
const CONFIG = 'config';

/** 한 번의 호출에서 옮길 거래 수. 함수 제한시간 안에 확실히 끝나는 크기. */
const COPY_CHUNK = 200;
/** 한 번의 호출에서 재압축할 이미지 수. 다운로드·인코딩이 있어 더 작다. */
const RECOMPRESS_CHUNK = 20;
const ARCHIVE_LEASE_MS = 10 * 60 * 1000;

/** 보관 이미지 목표 — services/image.js 의 마감 정책과 같은 값. */
const ARCHIVE_MAX_PX = 900;
const ARCHIVE_QUALITY = 60;

const PHASES = {
  COPY: 'copy',
  BALANCE: 'balance',
  RECOMPRESS: 'recompress',        // 거래의 영수증
  RECOMPRESS_BANK: 'recompressBank', // 그 해 통장 사진
  DONE: 'done',
};

module.exports = function archiveFns(ctx) {
  const { db, getBucket, callable, HttpsError, logger, FieldValue } = ctx;

  async function requireArchiver(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', '권한 정보가 아직 준비되지 않았습니다.');
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    if ((d.caps || {})[capName('settings.archive')] !== true) {
      throw new HttpsError('permission-denied', '연도 마감 권한이 없습니다.');
    }
    return d;
  }

  /**
   * 이미지 한 장을 저해상도로 다시 써 넣는다. **generation 사전조건을 건다.**
   *
   * 읽은 뒤 누군가 같은 경로를 교체했다면 generation 이 달라지고, 그때는
   * 덮어쓰지 않는다 — 새 증빙을 옛 사진으로 되돌리는 일이 없어야 한다.
   *
   * sharp 가 없으면 건너뛴다. 재압축은 저장 용량을 아끼는 일이지 마감의
   * 정확성과는 무관하다 — 없다고 마감이 실패하면 안 된다(기존에도
   * 버킷 CORS 가 없으면 건너뛰는 best-effort 였다).
   */
  async function recompressObject(path, expectedGeneration, year, assertLease) {
    let sharp;
    try {
      sharp = require('sharp');
    } catch (_) {
      return { skipped: 'sharp-없음' };
    }

    const file = getBucket().file(path);
    const [meta] = await file.getMetadata();
    const custom = meta.metadata || {};
    if (expectedGeneration != null
        && String(meta.generation) !== String(expectedGeneration)) {
      // 직전 실행이 Storage 저장 뒤 Firestore generation 반영 전에 끊긴 경우.
      if (String(custom.archiveSourceGeneration || '') === String(expectedGeneration)
          && String(custom.archiveYear || '') === String(year)) {
        return { recovered: true, generation: String(meta.generation) };
      }
      const err = new Error('기록된 generation과 Storage 객체가 다릅니다');
      err.code = 412;
      throw err;
    }
    if (!String(meta.contentType || '').startsWith('image/')) return { skipped: '이미지 아님' };
    const before = Number(meta.size || 0);

    const [buf] = await file.download();
    const out = await sharp(buf)
      .rotate()
      .resize({ width: ARCHIVE_MAX_PX, height: ARCHIVE_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: ARCHIVE_QUALITY })
      .toBuffer();

    if (out.length >= before) {
      return { skipped: '효과 없음', generation: String(meta.generation) };
    }

    // 이미지 처리 중 lease가 만료돼 다른 호출이 선점했을 수 있다. Storage는
    // Firestore 트랜잭션에 묶이지 않으므로 저장 직전에 소유권을 다시 확인한다.
    if (assertLease) await assertLease();

    await file.save(out, {
      contentType: 'image/jpeg',
      // 읽은 그 객체일 때만 덮어쓴다. 그 사이 교체됐으면 412 로 실패한다.
      preconditionOpts: { ifGenerationMatch: meta.generation },
      // 토큰을 보존한다 — 잃으면 이미 나가 있는 URL 이 전부 깨진다.
      metadata: { metadata: {
        ...custom,
        archiveSourceGeneration: String(meta.generation),
        archiveYear: String(year),
      } },
    });
    const [saved] = await file.getMetadata();
    return { before, after: out.length, generation: String(saved.generation) };
  }

  const millis = (value) => {
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (value instanceof Date) return value.getTime();
    return Number(value || 0);
  };

  const clearLease = () => ({ leaseToken: '', leaseUntil: new Date(0) });

  /** 진행 문서를 만들고 이번 호출의 lease를 원자적으로 선점한다. */
  async function claimProgress(year, uid, ref, token) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {
      type: 'archive', year, status: 'in_progress', phase: PHASES.COPY,
      startedAt: new Date().toISOString(), by: String(uid),
      count: 0, copied: 0, recompressed: 0,
      netByAccount: {}, recompressCursor: 0,
      };
      if (current.status === 'done') return { ...current, phase: PHASES.DONE };
      if (current.leaseToken && millis(current.leaseUntil) > Date.now()) {
        throw new HttpsError('aborted', '다른 연도 마감 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
      }
      tx.set(ref, {
        ...current,
        leaseToken: token,
        leaseUntil: new Date(Date.now() + ARCHIVE_LEASE_MS),
      }, { merge: true });
      return current;
    });
  }

  async function updateOwned(ref, token, patch) {
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      if (current.leaseToken !== token) {
        throw new HttpsError('aborted', '연도 마감 lease를 잃었습니다. 다시 시도하세요.');
      }
      tx.update(ref, patch);
      return current;
    });
  }

  async function heartbeat(ref, token) {
    await updateOwned(ref, token, { leaseUntil: new Date(Date.now() + ARCHIVE_LEASE_MS) });
  }

  /** 재압축 결과와 lease 확인을 같은 Firestore 트랜잭션에 둔다. */
  async function recordGeneration(logRef, token, targetRef, expectedGeneration, generation) {
    await db.runTransaction(async (tx) => {
      const logSnap = await tx.get(logRef);
      const targetSnap = await tx.get(targetRef);
      const current = logSnap.exists ? (logSnap.data() || {}) : {};
      if (current.leaseToken !== token || millis(current.leaseUntil) <= Date.now()) {
        throw new HttpsError('aborted', '연도 마감 lease를 잃었습니다. 다시 시도하세요.');
      }
      if (!targetSnap.exists) throw new HttpsError('not-found', '보관 거래를 찾을 수 없습니다.');
      const target = targetSnap.data() || {};
      if (String(target.receiptGeneration || '') !== String(expectedGeneration || '')) {
        throw new HttpsError('aborted', '재압축 중 증빙 버전이 바뀌었습니다. 다시 시도하세요.');
      }
      tx.update(targetRef, { receiptGeneration: String(generation) });
    });
  }

  async function release(ref, token) {
    try { await updateOwned(ref, token, clearLease()); } catch (_) { /* lease를 잃었으면 건드리지 않는다 */ }
  }

  // ───────────────────────────────────────────────────────────
  // runArchive — 한 번 부를 때마다 정해진 만큼만 하고 남은 일을 알려 준다
  // ───────────────────────────────────────────────────────────
  const runArchive = callable('runArchive', async (request) => {
    const auth = request.auth;
    await requireArchiver(auth);

    const year = Number((request.data || {}).year);
    if (!Number.isInteger(year) || year < 2000 || year > 2999) {
      throw new HttpsError('invalid-argument', '연도가 올바르지 않습니다.');
    }
    const archiveCol = `archive_${year}`;
    const logRef = db.collection(CONFIG).doc(archiveCol);
    const leaseToken = randomUUID();
    const progress = await claimProgress(year, auth.uid, logRef, leaseToken);

    if (progress.phase === PHASES.DONE) {
      return { phase: PHASES.DONE, done: true, ...counts(progress) };
    }

    // ── 1단계: 사본 저장 → 원본 삭제 ──
    if (progress.phase === PHASES.COPY) {
      try {
        return await db.runTransaction(async (tx) => {
          const logSnap = await tx.get(logRef);
          const current = logSnap.data() || {};
          if (current.leaseToken !== leaseToken) throw new HttpsError('aborted', '연도 마감 lease를 잃었습니다.');
          const snap = await tx.get(db.collection(TRANSACTIONS)
            .where('date', '>=', `${year}-01-01`)
            .where('date', '<=', `${year}-12-31`)
            .limit(COPY_CHUNK));
          if (snap.empty) {
            tx.update(logRef, { phase: PHASES.BALANCE, ...clearLease() });
            return { phase: PHASES.BALANCE, done: false, ...counts(current) };
          }
          const net = { ...(current.netByAccount || {}) };
          for (const d of snap.docs) {
            const t = d.data() || {};
            tx.set(db.collection(archiveCol).doc(d.id), {
              ...t, archivedFrom: d.id, archivedAt: current.startedAt,
            });
            if (t.type !== '취소' && t.accountId) {
              net[t.accountId] = (net[t.accountId] || 0)
                + (Number(t.amountIn || 0) - Number(t.amountOut || 0));
            }
            tx.delete(d.ref);
          }
          tx.update(logRef, {
            netByAccount: net,
            copied: FieldValue.increment(snap.size),
            count: FieldValue.increment(snap.size),
            ...clearLease(),
          });
          return { phase: PHASES.COPY, done: false, copied: (current.copied || 0) + snap.size };
        });
      } catch (err) {
        await release(logRef, leaseToken);
        throw err;
      }
    }

    // ── 2단계: 기초잔액 전진 ──
    if (progress.phase === PHASES.BALANCE) {
      const nextBase = `${year + 1}-01-01`;
      try {
        return await db.runTransaction(async (tx) => {
          const logSnap = await tx.get(logRef);
          const current = logSnap.data() || {};
          if (current.leaseToken !== leaseToken) throw new HttpsError('aborted', '연도 마감 lease를 잃었습니다.');
          const accounts = await tx.get(db.collection(ACCOUNTS));
          const net = current.netByAccount || {};
          let moved = 0;
          for (const d of accounts.docs) {
            const acc = d.data() || {};
            if (String(acc.initialBalanceDate || '') >= nextBase) continue;
            const balance = Number(acc.initialBalance || 0) + (net[d.id] || 0);
            tx.update(d.ref, {
              initialBalance: balance, initialBalanceDate: nextBase, currentBalance: balance,
            });
            moved += 1;
          }
          tx.update(logRef, {
            phase: PHASES.RECOMPRESS, accountsAdvanced: moved, ...clearLease(),
          });
          return { phase: PHASES.RECOMPRESS, done: false, accountsAdvanced: moved };
        });
      } catch (err) {
        await release(logRef, leaseToken);
        throw err;
      }
    }

    // ── 3단계: 보관용 재압축 (best-effort) ──
    //
    // 커서를 두 개 둔다. 거래를 다 돌면 통장 사진으로 넘어가고, 그것까지
    // 끝나면 마감이다. 한 단계 안에서 "남았는지"를 목록의 길이로만 판정하면
    // 같은 목록을 영원히 다시 받는다.
    const cursor = Number(progress.recompressCursor || 0);
    const bank = progress.phase === PHASES.RECOMPRESS_BANK;
    const { targets, exhausted, scanned } = bank
      ? await bankbookTargets(year, cursor)
      : await receiptTargets(archiveCol, cursor);

    if (exhausted) {
      if (!bank) {
        // 거래 쪽이 끝났다. 커서를 되돌리고 통장 사진으로 넘어간다.
        await updateOwned(logRef, leaseToken, {
          phase: PHASES.RECOMPRESS_BANK, recompressCursor: 0, ...clearLease(),
        });
        return { phase: PHASES.RECOMPRESS_BANK, done: false, ...counts(progress) };
      }
      await updateOwned(logRef, leaseToken, {
        phase: PHASES.DONE, status: 'done', archivedAt: new Date().toISOString(), ...clearLease(),
      });
      logger.info('[runArchive] 완료', { year, ...counts(progress) });
      return { phase: PHASES.DONE, done: true, ...counts(progress) };
    }

    let ok = 0;
    try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const path = target.path;
      let r;
      try {
        // 파일마다 lease를 연장하고, 압축 직후 Storage 쓰기 전에도 다시 확인한다.
        await heartbeat(logRef, leaseToken);
        r = await recompressObject(
          path, target.receiptGeneration, year,
          () => heartbeat(logRef, leaseToken),
        );
        if (!r.skipped) ok += 1;
      } catch (err) {
        // generation 충돌은 조용히 건너뛰면 archive 문서가 영구히 낡는다.
        if (Number(err && err.code) === 412) throw new HttpsError(
          'failed-precondition', `증빙 파일 버전이 달라 마감을 중단했습니다: ${path}`,
        );
        logger.warn('[runArchive] 재압축 건너뜀', { path, message: err && err.message });
        continue;
      }
      if (target.ref && r.generation
          && String(target.receiptGeneration || '') !== String(r.generation)) {
        // 이 쓰기는 이미지 오류처럼 삼키면 안 된다. 실패하면 cursor를 전진시키지
        // 않아 다음 호출이 archiveSourceGeneration metadata로 정확히 재개한다.
        await recordGeneration(
          logRef, leaseToken, target.ref, target.receiptGeneration, r.generation,
        );
      }
    }
    await updateOwned(logRef, leaseToken, {
      recompressed: FieldValue.increment(ok),
      // 커서는 **훑은 개수**만큼 나아간다. 압축한 개수만큼 나아가면
      // 증빙 없는 거래에서 제자리를 돈다.
      recompressCursor: cursor + scanned,
      ...clearLease(),
    });
    return { phase: progress.phase, done: false, recompressed: ok };
    } catch (err) {
      await release(logRef, leaseToken);
      throw err;
    }
  });

  /**
   * 다운로드 URL 에서 객체 경로를 되짚는다.
   *
   *   https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{인코딩된 경로}?alt=media&token=…
   *
   * 옛 거래는 경로 없이 이 URL 만 갖고 있다. 되짚지 못하면 이미 쌓여 있는
   * 영수증이 재압축 대상에서 통째로 빠진다 — 마감의 목적이 저장 용량인데.
   */
  function pathFromUrl(url) {
    const m = String(url || '').match(/\/o\/([^?]+)/);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (_) { return ''; }
  }

  /**
   * 이번 묶음에서 재압축할 영수증 경로.
   *
   * `{paths, exhausted}` 로 돌려주는 이유: 증빙이 하나도 없는 묶음이 있을 수
   * 있다. 빈 배열을 "끝났다"로 읽으면 그 뒤 거래를 통째로 건너뛴다 —
   * 목록의 길이와 진행 여부는 다른 이야기다.
   */
  async function receiptTargets(archiveCol, cursor) {
    const snap = await db.collection(archiveCol)
      .orderBy('__name__')
      .offset(cursor)
      .limit(RECOMPRESS_CHUNK)
      .get();

    const targets = [];
    for (const d of snap.docs) {
      const t = d.data() || {};
      const path = t.receiptPath || pathFromUrl(t.receiptUrl);
      if (path) targets.push({ path, ref: d.ref, receiptGeneration: t.receiptGeneration });
    }
    return { targets, exhausted: snap.empty, scanned: snap.size };
  }

  /**
   * 그 해 통장 사진. 브라우저 판과 달리 URL 을 다시 쓰지 않아도 된다 —
   * 서버는 다운로드 토큰을 보존한 채 덮어쓰므로 이미 나가 있는 URL 이 그대로
   * 유효하다. 예전에는 uploadBytes 가 토큰을 새로 발급해서 계좌 문서의
   * bankStatements 를 전부 고쳐 써야 했다.
   *
   * 장수가 많지 않아 전부 모은 뒤 커서로 잘라 쓴다.
   */
  async function bankbookTargets(year, cursor) {
    const accounts = await db.collection(ACCOUNTS).get();
    const yr = String(year);
    const all = [];
    for (const d of accounts.docs) {
      for (const st of ((d.data() || {}).bankStatements || [])) {
        const item = typeof st === 'string' ? { url: st, month: '' } : (st || {});
        if (!String(item.month || '').startsWith(yr)) continue;
        const path = pathFromUrl(item.url);
        if (path) all.push(path);
      }
    }
    const paths = all.slice(cursor, cursor + RECOMPRESS_CHUNK);
    return {
      targets: paths.map((path) => ({ path })),
      exhausted: cursor >= all.length,
      scanned: paths.length,
    };
  }

  const counts = (p) => ({
    count: p.count || 0, copied: p.copied || 0, recompressed: p.recompressed || 0,
  });

  return { runArchive };
};

module.exports.PHASES = PHASES;
module.exports.COPY_CHUNK = COPY_CHUNK;
