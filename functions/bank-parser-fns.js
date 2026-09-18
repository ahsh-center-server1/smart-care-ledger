'use strict';

/**
 * 은행 파서 콜러블 — `config/bankParsers` 문서 하나를 통째로 쓴다.
 *
 * 왜 콜러블인가
 *   `config/{id}` 쓰기는 규칙이 `settingsPermissions` 를 요구하는데 그 권한은
 *   **아무도 갖지 않는다**(고정 정책의 FORBIDDEN_KEYS). config 는 서버만 쓴다.
 *
 * 왜 `excel.upload` 인가 — 즉 왜 담당자가 은행을 추가할 수 있나
 *   파일을 가진 사람만이 어느 열이 출금인지 볼 수 있다. 이 권한을 팀장 쪽에
 *   두면 "개발자를 부르는 일"이 "팀장을 부르는 일"이 될 뿐이고, 정작 팀장은
 *   엑셀을 올리지 않아 그 파일을 열어 본 적이 없다.
 *
 *   위험이 낮은 것도 근거다. 이 설정이 정하는 것은 **파일을 어떻게 읽는가**
 *   뿐이고, 읽은 결과는 여전히 미리보기에서 사람이 확인한 뒤에야 저장된다.
 *   게다가 저장분은 언제나 내장 설정 **뒤**에서 판정되므로(bank-parser.cjs
 *   머리말), 최악의 경우가 "아직 안 되던 파일이 여전히 안 됨"이다.
 */

const {
  normalizeBankParser, normalizeBankParsers, bankParserProblem, MAX_SAVED_PARSERS,
} = require('./bank-parser.cjs');
const { fixedCan } = require('./fixed-role-policy.cjs');

const CONFIG = 'config';
const AUTHZ = 'authz';
const PARSERS_DOC = 'bankParsers';

module.exports = function bankParserFns(ctx) {
  const { db, callable, HttpsError, logger, FieldValue } = ctx;

  async function requireUploader(auth) {
    if (!auth || !auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
    const snap = await db.collection(AUTHZ).doc(auth.uid).get();
    if (!snap.exists) {
      throw new HttpsError('failed-precondition',
        '권한 정보가 아직 준비되지 않았습니다. 관리자에게 권한 백필을 요청하세요.');
    }
    const d = snap.data() || {};
    if (d.enabled !== true) throw new HttpsError('permission-denied', '비활성화된 계정입니다.');
    if (!fixedCan(d, 'excel.upload')) {
      throw new HttpsError('permission-denied', '은행 파서를 관리할 권한이 없습니다.');
    }
    return d;
  }

  async function readParsers() {
    const snap = await db.collection(CONFIG).doc(PARSERS_DOC).get();
    return normalizeBankParsers(snap.exists ? snap.data() : null);
  }

  async function writeParsers(parsers, uid) {
    await db.collection(CONFIG).doc(PARSERS_DOC).set({
      type: 'bankParsers',
      parsers,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
    });
  }

  /** 하나를 더하거나 같은 키를 덮어쓴다. 문서 통째로 받지 않는다 — 두 사람이
   *  동시에 추가하면 나중 사람이 앞사람의 설정을 통째로 지우게 된다. */
  const saveBankParser = callable('saveBankParser', async (request) => {
    const auth = request.auth;
    await requireUploader(auth);

    const draft = (request.data || {}).parser || {};
    const problem = bankParserProblem(draft);
    if (problem) throw new HttpsError('invalid-argument', problem);

    const parser = normalizeBankParser(draft);
    if (!parser) throw new HttpsError('invalid-argument', '설정을 만들 수 없습니다.');

    const current = await readParsers();
    const next = current.filter(p => p.key !== parser.key);
    if (next.length >= MAX_SAVED_PARSERS) {
      throw new HttpsError('failed-precondition',
        `은행 설정이 너무 많습니다 (최대 ${MAX_SAVED_PARSERS}개). 쓰지 않는 것을 지워 주세요.`);
    }
    next.push(parser);

    await writeParsers(next, auth.uid);
    logger.info('[saveBankParser] 저장', { key: parser.key, count: next.length, by: auth.uid });
    return { parsers: next, saved: parser };
  });

  const deleteBankParser = callable('deleteBankParser', async (request) => {
    const auth = request.auth;
    await requireUploader(auth);

    const key = String((request.data || {}).key || '').trim();
    if (!key) throw new HttpsError('invalid-argument', '지울 설정을 지정하세요.');

    const current = await readParsers();
    const next = current.filter(p => p.key !== key);
    if (next.length === current.length) {
      throw new HttpsError('not-found', '그 설정이 없습니다. 화면을 새로고침해 주세요.');
    }
    await writeParsers(next, auth.uid);
    logger.info('[deleteBankParser] 삭제', { key, count: next.length, by: auth.uid });
    return { parsers: next };
  });

  return { saveBankParser, deleteBankParser };
};
