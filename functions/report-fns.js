'use strict';

/**
 * 보고서 결재 — **전이표를 서버가 집행한다.**
 *
 * 무엇이 열려 있었나
 *   전이표(report-workflow)는 브라우저에만 있었고, 규칙은 reports 쓰기를
 *   등급으로만 막았다. 그래서 담당자 등급이면 콘솔에서
 *
 *     updateDoc(doc(db,'reports',id), { status:'confirmed',
 *                                       centerApprovedByName:'센터장' })
 *
 *   한 줄로 팀장·센터장 결재를 건너뛸 수 있었다. 그 달의 거래가 잠기고,
 *   인쇄물에는 결재란이 채워진 채로 나온다. 공문서 산출물이라 그냥 넘길 수 없다.
 *
 * 전이표는 한 벌이다
 *   functions/report-workflow.cjs 는 public/domain/report-workflow.js 를
 *   기계적으로 옮긴 생성물이다(tools/gen-report-workflow.mjs).
 *   손으로 옮겨 적으면 화면과 서버가 다른 규칙으로 결재를 판정한다.
 *
 * 배정 팀장 판정의 근거
 *   clientAccess/{clientId}/members/{uid}.isLeader — 담당 배정의 투영본이다.
 *   화면은 clients.teamLeader 문자열을 파싱해 판단했지만, 서버는 규칙과 같은
 *   투영본을 본다. 두 근거가 갈라지면 화면에는 버튼이 보이는데 서버가 거부한다.
 */

const { planTransition, normalizeStatus } = require('./report-workflow.cjs');
const { fixedCan } = require('./fixed-role-policy.cjs');
const { reportDocId } = require('./report-id.cjs');
const {
  LOCKED_MONTHS_DOC, lockIndexChange, submitIndexChange, approveIndexChange,
  SUBMITTED_STATUSES,
} = require('./locked-months.cjs');

const AUTHZ = 'authz';
const REPORTS = 'reports';
const CLIENT_ACCESS = 'clientAccess';
const MEMBERS = 'members';
const CONFIG = 'config';
const AUDIT_LOGS = 'auditLogs';
const AUDIT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * 클라이언트가 함께 보낼 수 있는 필드.
 *
 * 상태·도장은 전이표가 정한다. 여기 없는 필드를 받으면 결재 기록을 위조할 수
 * 있다 — 실제로 브라우저가 update 객체를 통째로 만들어 보내고 있었다.
 */
const CLIENT_FIELDS = ['staffComment', 'leaderComment', 'centerComment'];

/** summary 는 화면이 계산한 표시용 캐시다. 길이만 제한하고 내용은 믿지 않는다. */
const MAX_SUMMARY = 4000;

module.exports = function reportFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  async function requireAuthz(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError(
        'failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.',
      );
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    return d;
  }

  const capOf = (authz) => (key) => fixedCan(authz, key);

  function sees(authz, clientId) {
    if (capOf(authz)('client.view.all')) return true;
    const ids = authz.role === '팀장' ? authz.leaderClientIds : authz.accessibleClientIds;
    return Array.isArray(ids) && ids.includes(String(clientId));
  }

  /**
   * 배정 팀장인가, 그리고 그 자리가 비어 있는가.
   *
   * leaderVacant 는 "대행 결재를 허용해도 되는가"의 근거다. 느슨하면 센터장이
   * 언제든 팀장 단계를 건너뛸 수 있다 — 그것이 원래 모바일 앱의 구멍이었다.
   * 그래서 팀장이 **있고 결재할 수 있는 상태**인지까지 확인한다.
   */
  async function leaderState(clientId, uid, tx = null) {
    const query = db.collection(CLIENT_ACCESS).doc(String(clientId))
      .collection(MEMBERS).where('isLeader', '==', true);
    const snap = tx ? await tx.get(query) : await query.get();

    const leaders = snap.docs.map((d) => d.id);
    const isAssignedLeader = leaders.includes(String(uid));
    if (!leaders.length) return { isAssignedLeader, leaderVacant: true };

    // 배정된 팀장이 실제로 결재할 수 있는가(재직 + 권한).
    const authzSnaps = await Promise.all(leaders.map((id) => {
      const ref = db.collection(AUTHZ).doc(id);
      return tx ? tx.get(ref) : ref.get();
    }));
    const usable = authzSnaps.some((s) => {
      if (!s.exists) return false;
      const d = s.data() || {};
      return fixedCan(d, 'report.approve.team');
    });
    return { isAssignedLeader, leaderVacant: !usable };
  }

  /** 이 (입주자, 연, 월)의 보고서. 없으면 null. */
  /** 이 기간 키가 쓸 문서. 새로 만들 때는 언제나 여기에 만든다. */
  function canonicalRef(clientId, year, month) {
    return db.collection(REPORTS).doc(reportDocId(clientId, year, month));
  }

  /**
   * 기간 키로 보고서를 찾는다 — canonical 문서를 먼저 보고, 없으면 예전 쿼리.
   *
   * 예전 쿼리를 남기는 이유: 이 변경 전에 만들어진 보고서는 임의 ID 다.
   * 그것들을 배포가 조용히 이관하지 않는다(report-id.cjs 머리말 참고).
   */
  async function findReport(clientId, year, month) {
    const canon = await canonicalRef(clientId, year, month).get();
    if (canon.exists) return { id: canon.id, ...canon.data() };
    const snap = await db.collection(REPORTS)
      .where('clientId', '==', String(clientId))
      .where('year', '==', year)
      .where('month', '==', month)
      .limit(1)
      .get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  }

  function pickClientFields(extra, authz, isAssignedLeader) {
    const out = {};
    for (const key of CLIENT_FIELDS) {
      if (extra && Object.prototype.hasOwnProperty.call(extra, key)) {
        const allowed = (key === 'staffComment' && fixedCan(authz, 'report.submit'))
          || (key === 'leaderComment' && isAssignedLeader
            && fixedCan(authz, 'report.approve.team'))
          || (key === 'centerComment' && fixedCan(authz, 'report.approve.center'));
        if (allowed) out[key] = String(extra[key] || '').slice(0, MAX_SUMMARY);
      }
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────
  // applyReportTransition — 모든 결재 동작이 여기를 통과한다
  // ───────────────────────────────────────────────────────────
  const applyReportTransition = callable('applyReportTransition', async (request) => {
    const auth = request.auth;
    const authz = await requireAuthz(auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    const year = Number(d.year);
    const month = Number(d.month);
    const action = String(d.action || '').trim();

    if (!clientId) throw new HttpsError('invalid-argument', '입주자를 선택하세요.');
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new HttpsError('invalid-argument', '연월이 올바르지 않습니다.');
    }
    if (!sees(authz, clientId)) {
      throw new HttpsError('permission-denied', '담당하지 않는 입주자입니다.');
    }

    const report = await findReport(clientId, year, month);
    const summary = String(d.summary || '').slice(0, MAX_SUMMARY);
    let reportId = report && report.id;
    let resultPlan = null;
    await db.runTransaction(async (tx) => {
      const lockRef = db.collection(CONFIG).doc(LOCKED_MONTHS_DOC);
      const actorSnap = await tx.get(db.collection(AUTHZ).doc(auth.uid));
      const currentAuthz = actorSnap.exists ? actorSnap.data() || {} : {};
      if (currentAuthz.enabled !== true || !sees(currentAuthz, clientId)) {
        throw new HttpsError('permission-denied', '현재 담당 범위에서 제외된 입주자입니다.');
      }
      const { isAssignedLeader, leaderVacant } = await leaderState(clientId, auth.uid, tx);
      let lockChange = null;
      let submitChange = null;
      let approveChange = null;
      // 새로 만드는 경우에도 **트랜잭션 안에서 읽는다.** 예전에는 임의 ID 라
      // 읽을 문서가 없었고, 그래서 동시 첫 저장이 서로 충돌하지 않은 채 각자
      // 문서를 만들었다. 이제 경로가 같으므로 둘 중 하나가 재시도되고,
      // 재시도한 쪽은 앞사람이 만든 문서를 보고 그것을 갱신한다.
      const reportRef = reportId
        ? db.collection(REPORTS).doc(reportId)
        : canonicalRef(clientId, year, month);
      reportId = reportRef.id;
      const snap = await tx.get(reportRef);
      let currentReport = snap.exists ? (snap.data() || {}) : null;
      if (report && !snap.exists) {
        throw new HttpsError('not-found', '보고서를 찾을 수 없습니다.');
      }
      if (report && normalizeStatus(currentReport.status) !== normalizeStatus(report.status)) {
        throw new HttpsError(
          'aborted',
          '그 사이 보고서 상태가 바뀌었습니다. 새로고침 후 다시 시도하세요.',
        );
      }

      const plan = planTransition(action, currentReport && currentReport.status, {
        can: capOf(currentAuthz),
        userId: auth.uid,
        userName: String(d.userName || ''),
        isAuthor: !!currentReport && String(currentReport.createdBy || '') === auth.uid,
        isAssignedLeader,
        leaderVacant,
        now: new Date().toISOString(),
      });
      if (!plan.ok) throw new HttpsError('failed-precondition', plan.reason);
      resultPlan = plan;
      const extra = pickClientFields(d.extraSet, currentAuthz, isAssignedLeader);
      const patch = { status: plan.next, ...plan.set, ...extra };
      if (summary) patch.summary = summary;

      // 색인 변경은 **신규 생성 경로에서도** 계산한다.
      //
      // 예전에는 currentReport 가 있을 때만 계산했다. 마감 색인만 볼 때는
      // 그래도 맞았다(draft → confirmed 로 한 번에 갈 수 없다). 그런데 제출
      // 색인은 다르다 — 보고서가 없는 상태에서 submit 하면 문서가 곧바로
      // submitted 로 만들어지므로, 여기서 빠지면 그 달이 제출됐는데도 색인에
      // 없어 거래가 삭제된다.
      const beforeDoc = currentReport ? { ...currentReport, clientId, year, month } : null;
      const afterDoc = { ...(currentReport || {}), clientId, year, month, status: plan.next };
      lockChange = lockIndexChange(beforeDoc, afterDoc);
      submitChange = submitIndexChange(beforeDoc, afterDoc);
      approveChange = approveIndexChange(beforeDoc, afterDoc);
      if (lockChange || submitChange || approveChange) await tx.get(lockRef);

      if (currentReport) {
        const full = { ...patch };
        // 도착 상태보다 뒤 단계의 도장을 지운다 —
        // 취소된 서명이 인쇄물에 남지 않아야 한다.
        for (const f of plan.clear) full[f] = FieldValue.delete();
        tx.update(reportRef, full);
      } else {
        tx.set(reportRef, {
          clientId, year, month,
          createdAt: FieldValue.serverTimestamp(),
          // createdBy 는 서버가 정한다. 회수 권한 판정의 근거이므로
          // 클라이언트가 적을 수 있으면 남의 보고서를 회수할 수 있다.
          createdBy: auth.uid,
          createdByName: String(d.userName || ''),
          ...patch,
        });
      }

      if (lockChange || submitChange || approveChange) {
        const indexPatch = { updatedAt: FieldValue.serverTimestamp() };
        if (lockChange) {
          indexPatch.months = {
            [lockChange.key]: lockChange.locked ? true : FieldValue.delete(),
          };
        }
        if (submitChange) {
          indexPatch.submittedMonths = {
            [submitChange.key]: submitChange.submitted ? true : FieldValue.delete(),
          };
        }
        if (approveChange) {
          indexPatch.approvedMonths = {
            [approveChange.key]: approveChange.approved ? true : FieldValue.delete(),
          };
        }
        tx.set(lockRef, indexPatch, { merge: true });
      }

      const auditRef = db.collection(AUDIT_LOGS).doc();
      tx.set(auditRef, {
        action: 'report.transition',
        actorUid: auth.uid,
        clientId, targetId: reportId,
        detail: { action, from: plan.from, to: plan.next, lockKey: lockChange && lockChange.key },
        timestamp: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + AUDIT_TTL_MS),
      });
    });

    logger.info('[applyReportTransition]', {
      by: auth.uid, clientId, year, month, action,
      from: resultPlan.from, to: resultPlan.next,
    });
    return {
      ok: true, reportId, from: resultPlan.from,
      to: resultPlan.next, cleared: resultPlan.clear,
    };
  });

  // ───────────────────────────────────────────────────────────
  // saveReportComment — 의견란만 고친다
  //
  // 전이와 나누는 이유: 의견 저장은 상태를 바꾸지 않는다. 전이 콜러블에
  // 얹으면 "상태를 바꾸지 않는 전이"라는 특례가 생기고, 그 특례가 결국
  // 상태 검사를 우회하는 통로가 된다.
  // ───────────────────────────────────────────────────────────
  const saveReportComment = callable('saveReportComment', async (request) => {
    const auth = request.auth;
    await requireAuthz(auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    const year = Number(d.year);
    const month = Number(d.month);
    const key = String(d.key || '');

    if (!CLIENT_FIELDS.includes(key)) {
      throw new HttpsError('invalid-argument', '저장할 수 없는 항목입니다.');
    }
    if (!clientId || !Number.isInteger(year) || !Number.isInteger(month)) {
      throw new HttpsError('invalid-argument', '입주자와 연월이 필요합니다.');
    }
    const value = String(d.value || '').slice(0, MAX_SUMMARY);
    const report = await findReport(clientId, year, month);
    // 의견 저장도 보고서를 새로 만들 수 있다(담당자 의견이 첫 쓰기인 경우).
    // 같은 이유로 canonical 경로를 쓰고 트랜잭션 안에서 읽는다.
    const reportRef = report
      ? db.collection(REPORTS).doc(report.id)
      : canonicalRef(clientId, year, month);

    await db.runTransaction(async (tx) => {
      const actorSnap = await tx.get(db.collection(AUTHZ).doc(auth.uid));
      const reportSnap = await tx.get(reportRef);
      const actor = actorSnap.exists ? actorSnap.data() || {} : {};
      if (actor.enabled !== true || !sees(actor, clientId)) {
        throw new HttpsError('permission-denied', '현재 담당 범위에서 제외된 입주자입니다.');
      }

      const current = reportSnap.exists ? reportSnap.data() || {} : null;
      const status = normalizeStatus(current && current.status);
      const allowed = (key === 'staffComment'
          && fixedCan(actor, 'report.submit')
          && ['draft', 'rejected'].includes(status))
        || (key === 'leaderComment'
          && fixedCan(actor, 'report.approve.team')
          && Array.isArray(actor.leaderClientIds)
          && actor.leaderClientIds.includes(clientId)
          && status === 'submitted')
        || (key === 'centerComment'
          && fixedCan(actor, 'report.approve.center')
          && status === 'team_approved');
      if (!allowed) {
        throw new HttpsError('permission-denied', '이 단계의 의견란을 수정할 권한이 없습니다.');
      }
      if (!current && key !== 'staffComment') {
        throw new HttpsError('failed-precondition', '담당자가 보고서 초안을 만든 뒤 의견을 남길 수 있습니다.');
      }

      if (current) tx.update(reportRef, { [key]: value });
      else tx.set(reportRef, {
        clientId, year, month, status: 'draft',
        createdAt: FieldValue.serverTimestamp(),
        createdBy: auth.uid,
        createdByName: String(d.userName || ''),
        [key]: value,
      });
      tx.set(db.collection(AUDIT_LOGS).doc(), {
        action: 'report.comment', actorUid: auth.uid,
        clientId, targetId: reportRef.id, detail: { key },
        timestamp: FieldValue.serverTimestamp(),
        expireAt: new Date(Date.now() + AUDIT_TTL_MS),
      });
    });
    return { ok: true, reportId: reportRef.id };
  });

  // ───────────────────────────────────────────────────────────
  // deleteReport — 보고서 삭제
  //
  // 삭제도 서버가 한다. reports 쓰기를 전면 차단했으므로 브라우저의
  // deleteDoc 은 조용히 거부될 뿐이고(showConfirm 이 거부를 삼키던 것과 같은
  // 실패 방식이다), 무엇보다 "누가 지웠는가"가 남지 않는다.
  // ───────────────────────────────────────────────────────────
  const deleteReport = callable('deleteReport', async (request) => {
    const auth = request.auth;
    const authz = await requireAuthz(auth);

    const d = request.data || {};
    const clientId = String(d.clientId || '').trim();
    const year = Number(d.year);
    const month = Number(d.month);

    if (!clientId || !Number.isInteger(year) || !Number.isInteger(month)) {
      throw new HttpsError('invalid-argument', '입주자와 연월이 필요합니다.');
    }
    if (!capOf(authz)('report.delete')) {
      throw new HttpsError('permission-denied', '보고서 삭제 권한이 없습니다.');
    }
    if (!sees(authz, clientId)) {
      throw new HttpsError('permission-denied', '담당하지 않는 입주자입니다.');
    }

    const report = await findReport(clientId, year, month);
    if (!report) throw new HttpsError('not-found', '저장된 보고서가 없습니다.');

    // 제출 뒤에는 지울 수 없다. 결재자가 보고 있는(또는 이미 본) 보고서가
    // 사라지면 결재 이력만 남고 대상이 없어진다 — 되돌리려면 회수·결재 취소로
    // draft 로 내린 뒤 지운다. 색인도 그때 함께 풀린다.
    if (SUBMITTED_STATUSES.includes(normalizeStatus(report.status))) {
      throw new HttpsError(
        'failed-precondition',
        '제출된 보고서는 삭제할 수 없습니다. 회수하거나 결재를 취소한 뒤 삭제하세요.',
      );
    }

    await db.collection(REPORTS).doc(report.id).delete();
    logger.info('[deleteReport]', { by: auth.uid, clientId, year, month, status: report.status });
    return { ok: true, reportId: report.id };
  });

  return { applyReportTransition, saveReportComment, deleteReport };
};

module.exports.CLIENT_FIELDS = CLIENT_FIELDS;
