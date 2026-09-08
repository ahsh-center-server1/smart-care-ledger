'use strict';

/**
 * 권한 투영 — 담당 관계를 집행용 문서로 옮긴다. 순수 모듈이라 Firestore를 모른다.
 *
 * 왜 투영본이 필요한가
 *   담당 관계의 **업무 원본**은 clients.userIds(쉼표 문자열)와 clients.teamLeader다.
 *   그런데 보안 규칙은 그 형태로 판정할 수 없다:
 *     · 쉼표 문자열에서 'staff'를 찾으면 'staff2'도 걸린다(부분 일치)
 *     · 규칙이 clients를 읽어야 하는데, 그러면 거래 한 건마다 조회가 붙는다
 *
 *   그래서 두 투영본을 만든다:
 *     authz/{uid}.accessibleClientIds     일반 접근 판정의 **유일한 근거**
 *     clientAccess/{clientId}/members/{uid}.isLeader   결재 책임 판정의 유일한 근거
 *
 *   질문이 다르면 근거도 다르다("접근 가능한가" vs "결재자인가"). 같은 질문에
 *   근거가 둘인 상황은 만들지 않는다.
 *
 * 왜 배열을 authz 문서에 두는가
 *   Storage 규칙은 평가당 Firestore 문서를 2개까지만 읽는다. 담당 관계를
 *   clientAccess에서 읽으면 통장 경로(계좌 → 입주자 → 권한)가 한도를 넘는다.
 *   authz 문서 하나에 배열로 담으면 조회 1회로 끝나고 한도에 여유가 남는다.
 *
 *   커스텀 클레임에 담지 않는 이유는 다르다 — 클레임은 1KB 제한에 토큰 갱신까지
 *   지연되지만, 문서는 매 평가마다 최신값을 읽는다.
 *
 * 왜 트리거가 아니라 서버 함수인가
 *   담당을 해제하는 순간부터 투영본이 갱신되기까지 창이 열리면, 해제된 사용자가
 *   그 사이에 계속 접근한다. Firestore 트리거는 순서도 시각도 보장하지 않는다.
 *   그래서 정상 변경은 **원본과 투영본을 한 트랜잭션**에서 쓰고, 트리거는
 *   집행이 아니라 정합성 복구에만 쓴다.
 */

/** 컬렉션·필드 이름 — 규칙과 계약 테스트가 같은 상수를 참조한다. */
const AUTHZ = 'authz';
const CLIENT_ACCESS = 'clientAccess';
const MEMBERS = 'members';

/**
 * 한 번의 담당 변경이 만들 수 있는 쓰기 수 상한.
 *
 * Firestore 트랜잭션 한도는 500이지만 여유를 둔다. 담당자 선택 화면에는
 * 인원 제한이 없어서, 직원이 늘면 쓰기 수도 함께 는다 — 한도에 닿아
 * **트랜잭션이 통째로 실패하기 전에** 거부해 이유를 알려주는 편이 낫다.
 */
const MAX_ASSIGNMENT_WRITES = 400;

/**
 * 쉼표 문자열 → 정규화된 uid 배열.
 *
 * 중복과 공백을 없앤다. 정규화하지 않으면 같은 사람이 두 번 들어와 쓰기 수가
 * 부풀고, 트랜잭션 안에서 같은 문서를 두 번 쓰려다 실패한다.
 */
function parseStaffIds(raw) {
  if (Array.isArray(raw)) return dedupe(raw);
  return dedupe(String(raw || '').split(','));
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = String(item == null ? '' : item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 재직 여부 — authz.enabled 의 유일한 계산식.
 *
 * approved 를 빼면 승인 취소가 기존 세션에 반영되지 않는다. 로그인 함수는
 * approved 와 active 를 모두 확인하는데, 규칙이 active 만 보면 승인이 취소된
 * 계정이 이미 발급된 토큰으로 계속 통과한다.
 */
function isEnabled(user) {
  if (!user) return false;
  return user.approved !== false && user.active !== false;
}

/**
 * 담당 변경 → 투영본 변경 계획. **순수 함수.**
 *
 * 핵심 규칙 — accessibleClientIds 는 staff ∪ leader 다.
 *   담당 직원에서 빠졌지만 여전히 결재 책임자인 사람을 배열에서 지우면 결재를
 *   할 수 없게 된다. 두 관계를 독립적으로 처리하면 반드시 이 실수를 한다.
 *
 * @param {Object} p
 * @param {string} p.clientId
 * @param {{staff: string[], leader: string}} p.prev  현재 상태
 * @param {{staff: string[], leader: string}} p.next  바꿀 상태
 * @returns {{
 *   memberOps: Array<{uid: string, op: 'set'|'delete', isStaff: boolean, isLeader: boolean}>,
 *   accessOps: Array<{uid: string, op: 'add'|'remove'}>,
 *   affectedUids: string[],
 *   writeCount: number,
 * }}
 */
function planAssignmentChange({ clientId, prev, next }) {
  if (!clientId) throw new Error('clientId가 필요합니다');

  const prevStaff = new Set(parseStaffIds(prev && prev.staff));
  const nextStaff = new Set(parseStaffIds(next && next.staff));
  const prevLeader = String((prev && prev.leader) || '').trim();
  const nextLeader = String((next && next.leader) || '').trim();

  const touched = new Set([...prevStaff, ...nextStaff]);
  if (prevLeader) touched.add(prevLeader);
  if (nextLeader) touched.add(nextLeader);

  const memberOps = [];
  const accessOps = [];

  for (const uid of touched) {
    const wasStaff = prevStaff.has(uid);
    const wasLeader = uid === prevLeader;
    const isStaff = nextStaff.has(uid);
    const isLeader = uid === nextLeader;

    const had = wasStaff || wasLeader;
    const has = isStaff || isLeader;

    // 멤버 문서 — 관계가 남아 있으면 갱신, 완전히 끊기면 삭제.
    // 역할만 바뀐 경우(담당자 → 결재자)도 갱신이 필요하다.
    if (has) {
      if (!had || wasStaff !== isStaff || wasLeader !== isLeader) {
        memberOps.push({ uid, op: 'set', isStaff, isLeader });
      }
    } else if (had) {
      memberOps.push({ uid, op: 'delete', isStaff: false, isLeader: false });
    }

    // 접근 배열 — 합집합이 바뀔 때만. 담당자 → 결재자 전환은 건드리지 않는다.
    if (has && !had) accessOps.push({ uid, op: 'add' });
    else if (!has && had) accessOps.push({ uid, op: 'remove' });
  }

  // 정확한 쓰기 수. `1 + 2 × 영향받은 인원`은 상한이고, 역할만 바뀐 사람은
  // 접근 배열을 건드리지 않으므로 실제로는 그보다 적다.
  const writeCount = 1 + memberOps.length + accessOps.length;

  return {
    memberOps,
    accessOps,
    affectedUids: [...touched],
    writeCount,
  };
}

/**
 * 이 변경을 트랜잭션으로 시도해도 되는가.
 *
 * 트랜잭션을 시작한 뒤 한도에 닿으면 통째로 실패하고, 사용자에게는 원인 없는
 * 오류만 남는다. **시작 전에** 거부해 무엇이 문제인지 알려준다.
 */
function assertWritable(plan) {
  if (plan.writeCount > MAX_ASSIGNMENT_WRITES) {
    throw new Error(
      `한 번에 바꿀 수 있는 담당 인원을 넘었습니다 (쓰기 ${plan.writeCount}건 > ${MAX_ASSIGNMENT_WRITES}건). `
      + '나누어 저장하세요.',
    );
  }
  return plan;
}

/** clientAccess 멤버 문서 경로. 규칙과 같은 모양이어야 한다. */
function memberPath(clientId, uid) {
  return `${CLIENT_ACCESS}/${clientId}/${MEMBERS}/${uid}`;
}

/**
 * authz 문서의 초기 형태.
 *
 * caps 는 여기서 만들지 않는다 — 권한 카탈로그가 필요하고, 그 카탈로그는
 * public/domain/perm-catalog.js 에 있어 functions/ 배포에 포함되지 않는다.
 * caps 백필은 별도 단계이고, 그때까지 caps 가 없는 문서는 **모든 권한이
 * 거부된다**(fail-closed). 새 경로가 준비되기 전에 열리지 않게 하는 것이 목적이다.
 */
function newAuthzDoc({ uid, role, isAdmin, approved, active, accessibleClientIds }) {
  return {
    uid: String(uid),
    role: String(role || '입력자'),
    isAdmin: isAdmin === true,
    enabled: isEnabled({ approved, active }),
    accessibleClientIds: dedupe(accessibleClientIds || []),
    // caps 와 capSchemaVersion 은 백필이 채운다(withCaps). 없으면 전부 거부다.
  };
}

/**
 * authz 문서에 권한 스냅샷을 얹는다.
 *
 * caps 는 규칙이 등급 계산 없이 읽는 불리언 묶음이고, capSchemaVersion 은
 * 카탈로그 형태가 바뀌었는지 판정하는 값이다. 둘 다 없으면 규칙이 거부한다.
 *
 * 계산 자체는 perm-catalog.cjs 가 한다 — 이 파일은 Firestore 도 카탈로그도
 * 모르는 순수 모듈로 두고, 호출부가 계산 결과를 넘긴다.
 */
function withCaps(doc, caps, capSchemaVersion) {
  return { ...doc, caps: { ...caps }, capSchemaVersion };
}

/**
 * 입주자 목록에서 사용자별 담당 입주자를 뽑는다. **순수 함수.**
 *
 * 백필은 clients 원본(userIds · teamLeader)에서 투영본을 다시 만든다.
 * 이벤트의 옛 값을 쓰지 않고 항상 현재 원본을 읽는 이유는 정합성 복구가
 * 낡은 상태를 되살리지 않게 하기 위해서다.
 *
 * ★ staff 와 leader 의 **합집합**이다. 담당 직원에서 빠졌지만 결재 책임자로
 *   남은 사람을 빼면 그 사람이 자기 결재 대상을 못 보게 된다.
 *
 * @param {Array<{id: string, userIds?: string, teamLeader?: string}>} clients
 * @returns {{ accessByUid: Map<string, string[]>, membersByClient: Map<string, Array> }}
 */
function projectAssignments(clients) {
  const accessByUid = new Map();
  const membersByClient = new Map();

  for (const c of clients || []) {
    const clientId = String(c && c.id ? c.id : '').trim();
    if (!clientId) continue;

    const staff = new Set(parseStaffIds(c.userIds));
    const leader = String(c.teamLeader || '').trim();
    const members = [];

    const touched = new Set(staff);
    if (leader) touched.add(leader);

    for (const uid of touched) {
      const isStaff = staff.has(uid);
      const isLeader = uid === leader;
      members.push({ uid, isStaff, isLeader });
      if (!accessByUid.has(uid)) accessByUid.set(uid, []);
      accessByUid.get(uid).push(clientId);
    }
    membersByClient.set(clientId, members);
  }

  // 담당 목록의 중복·순서를 정리한다 — 같은 입주자가 두 번 들어오면
  // 배열이 부풀고 diff 가 시끄러워진다.
  for (const [uid, ids] of accessByUid) accessByUid.set(uid, dedupe(ids).sort());

  return { accessByUid, membersByClient };
}

module.exports = {
  AUTHZ,
  CLIENT_ACCESS,
  MEMBERS,
  MAX_ASSIGNMENT_WRITES,
  parseStaffIds,
  isEnabled,
  planAssignmentChange,
  assertWritable,
  memberPath,
  newAuthzDoc,
  withCaps,
  projectAssignments,
};
