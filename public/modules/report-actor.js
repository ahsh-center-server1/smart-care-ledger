/**
 * modules/report-actor.js — 결재의 신원 컨텍스트와 문구 표
 *
 * report.js 에서 떼어 왔다. 그 파일은 상한을 넘겨 있고
 * test/architecture.test.mjs 가 "기능을 더할 곳이 아니라 쪼갤 곳"이라고 말한다.
 * 예외 목록의 주석이 지목한 갈래(view / approval / excel / annual) 중
 * approval 쪽의 첫 조각이다.
 *
 * 왜 이 조각인가 — 순환이 생기지 않는다
 *   여기 있는 것들은 S · permissions · domain/report-workflow 만 본다.
 *   report.js 를 부르지 않으므로 화살표가 한 방향이다.
 *   결재 실행부까지 함께 옮기면 loadReport·renderReportList 를 되불러야 해서
 *   순환이 생긴다 — 그것은 다음 조각의 일이다.
 */

'use strict';

import { S } from '../state.js';
import { can, requiredRank, ROLE_RANK, ADMIN_RANK } from './permissions.js';

/**
 * 화면에서 신원 정보를 만든다 — S.user 기준.
 *
 * domain/report-workflow.js 는 S 도 can 도 모른다(서버가 같은 파일을 쓰기
 * 때문이다). 그 둘을 붙이는 자리가 여기다.
 */
export function actorContext({ report, isAssignedLeader = false, leaderVacant = false } = {}) {
  const userId = String(S.user?.userId || '');
  return {
    can,
    userId,
    userName: S.user?.name || '',
    isAuthor: !!report?.createdBy && String(report.createdBy) === userId,
    isAssignedLeader,
    leaderVacant,
  };
}
/**
 * 현재 보고서에 대한 신원 컨텍스트.
 * teamLeader는 저장 경로에 따라 문서 ID 또는 로그인 아이디로 들어올 수 있어
 * 양쪽 모두로 매칭한다(마이그레이션 전 데이터 방어).
 */
export function reportActorContext(){
  const report=S.reportData?.report;
  const userId=String(S.user?.userId||'');
  const client=(S.allClients||S.clients||[]).find(c=>c.id===S.reportData?.clientId);
  const teamLeaderId=String(client?.teamLeader||'');
  const users=S.users||[];
  const me=users.find(u=>String(u.id)===userId||String(u.userId)===userId);
  // **배정된 팀장인가**(신원)와 **팀장 결재를 할 수 있는가**(권한)를 나눠 본다.
  // 예전에는 role==='팀장' 하나로 묶여 있어 배정 팀장이 센터장이거나 관리자면
  // 결재 버튼이 아예 나오지 않았다.
  const isAssignedLeader=!!teamLeaderId&&(teamLeaderId===userId||(!!me&&teamLeaderId===String(me.id)));
  // 배정 팀장이 공석/삭제/결재불가/퇴사(비활성)면 vacant → 상위 등급이 대행
  const leaderUser=users.find(u=>String(u.id)===teamLeaderId||String(u.userId)===teamLeaderId);
  const leaderRank=leaderUser?(leaderUser.isAdmin?ADMIN_RANK:(ROLE_RANK[leaderUser.role]||0)):0;
  const leaderVacant=!teamLeaderId||!leaderUser
    ||leaderRank<requiredRank('report.approve.team')
    ||leaderUser.active===false;
  const staffIds=String(client?.userIds||'').split(',').map(x=>x.trim());
  return {
    ...actorContext({report,isAssignedLeader,leaderVacant}),
    isDirectStaff:staffIds.includes(userId),
  };
}

export const TRANSITION_TOAST={
  save:'임시저장되었습니다.',
  submit:'제출되었습니다.',
  submitAsLeader:'팀장 직접 제출 완료! 센터장 결재 대기 중.',
  approveTeam:'팀장 결재 완료.',
  approveTeamProxy:'팀장 결재를 대행 처리했습니다. 센터장 최종 결재 대기 중.',
  approveCenter:'최종 결재 완료.',
  reject:'보고서가 반려되었습니다.',
  recall:'보고서가 초안으로 회수되었습니다.',
  revert:'결재가 취소되었습니다.',
  release:'반려를 해제하고 초안으로 되돌렸습니다.',
};

/**
 * 전이 → 변경 이력 액션 코드.
 * 전이표(report-workflow.js)에 동작을 추가하면 여기도 채워야 한다 —
 * test/audit.test.mjs가 라벨 없는 코드를 잡고, 빠진 동작은 report.save로
 * 기록되어 이력이 부정확해진다.
 */
export const TRANSITION_AUDIT={
  save:'report.save',
  submit:'report.submit',
  submitAsLeader:'report.submit',
  approveTeam:'report.approveTeam',
  approveTeamProxy:'report.approveTeam',
  approveCenter:'report.approveCenter',
  reject:'report.reject',
  recall:'report.recall',
  revert:'report.revert',
  release:'report.release',
};

// 결재 취소 버튼은 되돌아가는 단계에 따라 문구가 달라야 한다
export const REVERT_LABEL={confirmed:'↩️ 최종 결재 취소',team_approved:'↩️ 팀장 결재 취소',submitted:'✏️ 수정(초안)'};
export const REVERT_MSG={
  confirmed:'최종 결재를 취소하고 팀장결재 상태로 되돌립니다.',
  team_approved:'팀장 결재를 취소하고 제출 상태로 되돌립니다.',
  submitted:'제출을 취소하고 초안 상태로 되돌립니다.',
};
