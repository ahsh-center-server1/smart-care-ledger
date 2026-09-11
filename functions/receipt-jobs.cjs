'use strict';

/**
 * 영수증 최종화 작업의 상태 기계. 순수 모듈이라 Firestore·Storage를 모른다.
 *
 * 왜 상태 문서가 따로 있는가
 *   Storage 객체 복사와 Firestore 거래 갱신은 **한 트랜잭션으로 묶을 수 없다.**
 *   그래서 실패 지점마다 무엇을 되돌리고 무엇을 유지할지 미리 정해 둬야 한다.
 *   상태를 Storage 객체에 매달 수는 없으므로 Firestore 문서로 분리한다:
 *
 *     Storage    receiptStaging/{uid}/{uploadId}/source     파일만
 *     Firestore  receiptJobs/{uid}/items/{uploadId}         상태만
 *
 *   경로에 uid를 넣은 이유는 규칙이 소유권을 **경로로** 검증할 수 있게 하려는
 *   것이다. 문서 안의 필드로 판정하면 남의 job을 가리키는 문서를 만들 수 있다.
 *
 * 왜 leaseToken 이 필요한가
 *   state 만으로는 동시 최종화를 막을 수 없다. 두 호출이 같은 job을 집으면
 *   둘 다 finalizing 을 보고 진행한다. 그래서 선점할 때 무작위 토큰을 발급하고,
 *   복사·첨부를 끝낼 때 **그 토큰이 아직 자기 것인지 다시 확인**한다.
 *   늦게 돌아온 이전 작업자가 새 작업 결과를 덮지 못한다.
 *
 * 왜 finalizing 에서도 재개할 수 있어야 하는가
 *   선점하면 상태가 finalizing 이 된다. 그 상태에서 서버가 죽으면
 *   `state === 'analyzed'` 조건으로는 다시 집을 수 없다 — lease 가 만료돼도
 *   영구 정지다. 설계 검토에서 잡힌 교착이고, 그래서 재개 조건이 두 갈래다.
 *
 * leaseToken 은 Firestore 소유권만 보호한다
 *   Storage 객체에는 자동으로 적용되지 않는다. 최종 파일 쪽은 generation
 *   사전조건이 담당한다 — 이 모듈은 그 값을 담아 두기만 하고, 조건부 삭제
 *   규칙은 STATES 주석과 canDeleteFinal() 에 있다.
 */

/**
 * 상태 흐름.
 *
 *   uploaded  → analyzed → finalizing → attached → cleanup_pending → completed
 *                  ↑___________|
 *                  lease 만료 시 재개
 */
const STATES = {
  /** 스테이징에 파일이 올라갔다. 아직 판독하지 않았다. */
  UPLOADED: 'uploaded',
  /** 판독이 끝나 사용자 검토를 기다린다. 최종화를 선점할 수 있는 상태. */
  ANALYZED: 'analyzed',
  /** 누군가 선점했다. lease 가 만료되면 다시 선점할 수 있다. */
  FINALIZING: 'finalizing',
  /** 거래에 붙었다. 이 시점부터 최종 객체는 거래의 증빙이다. */
  ATTACHED: 'attached',
  /** 첨부는 끝났고 스테이징 정리만 남았다. */
  CLEANUP_PENDING: 'cleanup_pending',
  /** 정리까지 끝났다. */
  COMPLETED: 'completed',
};

const ALL_STATES = Object.values(STATES);

/** 최종화를 선점할 수 있는 상태 — 아래 canClaim() 참고. */
const CLAIMABLE = [STATES.ANALYZED, STATES.FINALIZING];

/** 최종 객체가 이미 거래의 증빙인 상태. 여기서는 파일을 지우면 안 된다. */
const ATTACHED_STATES = [STATES.ATTACHED, STATES.CLEANUP_PENDING, STATES.COMPLETED];

/** 선점 유효 시간. 판독이 아니라 복사·첨부에 걸리는 시간이 기준이다. */
const LEASE_MS = 120 * 1000;

/** 스테이징 파일 수명. 사용자가 검토를 중단하고 떠나는 경우가 실제로 있다. */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

function millis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number(value);
}

/**
 * 최종화를 선점할 수 있는가.
 *
 * 두 갈래다:
 *   · analyzed        — 아직 아무도 잡지 않았다
 *   · finalizing 이고 lease 만료 — 이전 작업자가 죽었다
 *
 * 두 번째가 없으면 서버가 finalizing 중에 죽는 순간 그 job 은 영구 정지된다.
 */
function canClaim(job, now) {
  if (!job) return false;
  if (job.state === STATES.ANALYZED) return true;
  if (job.state !== STATES.FINALIZING) return false;
  // 읽을 수 없는 leaseUntil 은 **만료로 본다.** NaN 을 "선점 불가"로 처리하면
  // 값이 손상된 job 이 영구히 갇힌다 — 막으려던 교착이 다른 경로로 되살아난다.
  // 정확성은 첨부 시점의 holdsLease() 가 지킨다(토큰·상태·만료를 다시 본다).
  const until = millis(job.leaseUntil);
  return !Number.isFinite(until) || until <= now;
}

/**
 * 선점 후 job 에 담을 값. `token` 은 호출부가 만든 무작위 문자열이다
 * (난수 생성은 순수 함수가 할 일이 아니다).
 */
function claimPatch({ token, now, trxId }) {
  if (!token) throw new Error('leaseToken이 필요합니다');
  return {
    state: STATES.FINALIZING,
    leaseToken: String(token),
    leaseUntil: new Date(now + LEASE_MS),
    ...(trxId ? { trxId: String(trxId) } : {}),
  };
}

/**
 * 이 작업자가 아직 lease 를 들고 있는가.
 *
 * 복사가 끝난 뒤와 거래 첨부 트랜잭션 안에서 **각각** 확인한다. 한 번만
 * 확인하면 그 사이에 lease 를 빼앗긴 작업자가 결과를 덮는다.
 */
function holdsLease(job, token, now) {
  if (!job || !token) return false;
  if (job.leaseToken !== token) return false;
  if (job.state !== STATES.FINALIZING) return false;
  return millis(job.leaseUntil || 0) > now;
}

/** 오래 걸리는 작업을 위한 lease 연장. 연장도 소유권을 다시 확인한다. */
function heartbeatPatch({ job, token, now }) {
  if (!holdsLease(job, token, now)) throw new Error('lease-lost');
  return { leaseUntil: new Date(now + LEASE_MS) };
}

/**
 * 최종 객체 경로 — uploadId 에서 **결정적으로** 나온다.
 *
 * 두 작업자가 같은 원본(스테이징의 불변 객체 1건)을 같은 목적지로 복사하면
 * 내용이 바이트 단위로 같다. 그래서 작업자별 경로를 만들 필요가 없고,
 * create-only(ifGenerationMatch: 0) 복사로 충돌을 처리할 수 있다.
 */
function finalPath(clientId, uploadId) {
  if (!clientId || !uploadId) throw new Error('clientId와 uploadId가 필요합니다');
  return `receipts/${clientId}/${uploadId}`;
}

/** 스테이징 원본 경로. 규칙이 경로의 uid 로 소유권을 본다. */
function stagingPath(uid, uploadId) {
  if (!uid || !uploadId) throw new Error('uid와 uploadId가 필요합니다');
  return `receiptStaging/${uid}/${uploadId}/source`;
}

/** job 문서 경로. */
function jobPath(uid, uploadId) {
  if (!uid || !uploadId) throw new Error('uid와 uploadId가 필요합니다');
  return `receiptJobs/${uid}/items/${uploadId}`;
}

/**
 * 이 job 의 최종 객체를 지워도 되는가.
 *
 * **연도 마감 재압축이 같은 경로를 덮어써 generation 을 바꾼다.** 그래서
 * 경로만 보고 지우면 남의(또는 새) 객체를 지운다. 두 조건을 함께 요구한다:
 *
 *   · 첨부된 적이 없다 — 거래의 증빙이면 job 수명과 무관하게 보존한다
 *     (job TTL 은 임시 작업을 정리할 뿐, 증빙 보존 기간을 정하지 않는다)
 *   · 기록해 둔 generation 과 실제 객체의 generation 이 같다
 */
function canDeleteFinal(job, actualGeneration) {
  if (!job) return false;
  if (ATTACHED_STATES.includes(job.state)) return false;
  const recorded = job.finalGeneration;
  if (recorded == null || actualGeneration == null) return false;
  return String(recorded) === String(actualGeneration);
}

/** 폐기 대상인가 — 첨부되지 않은 채 수명을 넘겼다. */
function isAbandoned(job, now) {
  if (!job) return false;
  if (ATTACHED_STATES.includes(job.state)) return false;
  return millis(job.expireAt || 0) <= now;
}

/**
 * 정리 순서. **파일 → job** 이다.
 *
 * TTL 이 job 을 먼저 지우면 남은 Storage 객체를 추적할 근거(경로·generation)가
 * 사라져 고아 파일이 영구히 남는다.
 */
const CLEANUP_ORDER = ['final', 'staging', 'job'];

/** 새 job 문서. */
function newJob({ uid, uploadId, clientId, now }) {
  if (!uid || !uploadId || !clientId) {
    throw new Error('uid·uploadId·clientId가 모두 필요합니다');
  }
  return {
    uid: String(uid),
    uploadId: String(uploadId),
    clientId: String(clientId),
    state: STATES.UPLOADED,
    stagingPath: stagingPath(uid, uploadId),
    attempts: 0,
    leaseToken: '',
    leaseUntil: new Date(0),
    expireAt: new Date(now + STAGING_TTL_MS),
  };
}

module.exports = {
  STATES,
  ALL_STATES,
  CLAIMABLE,
  ATTACHED_STATES,
  LEASE_MS,
  STAGING_TTL_MS,
  millis,
  CLEANUP_ORDER,
  canClaim,
  claimPatch,
  holdsLease,
  heartbeatPatch,
  finalPath,
  stagingPath,
  jobPath,
  canDeleteFinal,
  isAbandoned,
  newJob,
};
