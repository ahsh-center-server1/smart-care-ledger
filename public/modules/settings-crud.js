// public/modules/settings-crud.js
//
// 입주자·계좌·직원의 **변경**만 담는다 — 목록 렌더링은 settings.js의 몫이다.
//
// 왜 분리했나
//   이 세 동작이 서버 콜러블로 옮겨 가면서 유형별 분기가 필요해졌고,
//   settings.js는 이미 architecture 테스트가 "쪼갤 곳"으로 묶어 둔 파일이었다.
//   허용치를 올리는 대신 실제로 쪼갠다.
//
// 왜 서버 콜러블인가
//   clients·users 쓰기는 보안 규칙이 브라우저에 막아 두었다. 담당 배정이
//   원본과 두 투영본(authz.accessibleClientIds · clientAccess의 members)을
//   함께 바꿔야 하기 때문이다 — 근거는 functions/client-fns.js 머리말에.
//
//   실제로 직원 삭제는 이 규칙에 막혀 **조용히 실패하고 있었다.**
//   showConfirm이 거부를 삼켜서 대화상자만 닫히고 감사 기록도 없었다.
//
// 순환 참조를 피하는 법
//   변경 뒤에는 목록을 다시 그려야 하는데 그 함수는 settings.js에 있다.
//   직접 import하면 settings.js ↔ 이 파일이 순환이 된다. 그래서 settings.js가
//   registerCrudRefresh()로 넘겨준다 — settings-shell.js의 registerPanel과
//   같은 방식이다.

'use strict';

import { S } from '../state.js';
import { COLS } from '../constants.js';
import { fb, fdb } from '../services/firestore.js';
import { toast, showConfirm } from '../utils/ui.js';
import { auditLog } from '../services/audit.js';

/**
 * settings.js가 넘겨주는 의존들.
 *
 * core.js를 직접 import하지 않는 이유: core는 이미 큰 순환 무리에 속해 있고,
 * 여기서 import하면 이 파일도 그 무리에 끌려 들어간다
 * (test/architecture.test.mjs의 "새로 얽히는 모듈이 없다"가 잡는다).
 * 필요한 함수만 받아 쓰면 이 파일은 무리 밖에 남는다.
 */
let deps = {
  refresh: () => {},
  refetchUsers: async () => {},
  refetchClients: async () => {},
  refetchAccounts: async () => {},
};

export function registerCrudDeps(next) { deps = { ...deps, ...next }; }

export async function toggleClientActive(id,makeActive){
  try{
    // clients 쓰기는 서버 전용 (functions/client-fns.js 참고).
    await window._fbFn.call('setClientActive')({clientId:id,active:makeActive});
    await auditLog('client.activeChange',{resourceId:id,summary:{
      clientName:(S.allClients||S.clients).find(c=>c.id===id)?.name||id,
      to:makeActive?'활성':'비활성'}});
    toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
    await deps.refetchClients(); deps.refresh();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}
export async function toggleAccountActive(id,makeActive){
  try{
    const{doc,updateDoc}=fb();
    await updateDoc(doc(fdb(),COLS.ACCOUNTS,id),{active:makeActive});
    await auditLog('account.activeChange',{resourceId:id,summary:{
      accountLabel:(S.allAccounts||S.accounts).find(a=>a.id===id)?.label||id,
      to:makeActive?'활성':'비활성'}});
    toast(makeActive?'활성화되었습니다.':'비활성화되었습니다.','success');
    await deps.refetchAccounts(); deps.refresh();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}
// 직원 재직/퇴사(비활성) 토글 — 비활성 시 로그인 차단, 데이터·결재 이력은 보존
export async function toggleStaffActive(id,makeActive){
  // 본인 계정 비활성화 방지 (셀프 잠금 방지)
  const self=S.users.find(u=>String(u.userId)===String(S.user?.userId));
  if(!makeActive&&self&&String(self.id)===String(id)){toast('본인 계정은 비활성화할 수 없습니다.','error');return;}
  try{
    // users 쓰기는 보안 규칙이 막는다. 서버가 등급을 확인하고,
    // 마지막 관리자를 비활성화해 영구 잠금되는 것도 막아 준다.
    await window._fbFn.call('setStaffActive')({ userId:id, active:makeActive });
    await auditLog('staff.activeChange',{resourceId:id,summary:{
      target:S.users.find(u=>u.id===id)?.name||id, to:makeActive?'재직':'퇴사'}});
    // 비활성화 대상이 어느 입주자의 팀장이면 안내 (결재 공백 방지)
    if(!makeActive){
      const asLeader=(S.allClients||S.clients).filter(c=>String(c.teamLeader)===String(id));
      if(asLeader.length)toast(`이 직원은 입주자 ${asLeader.length}명의 팀장입니다. 팀장을 재지정하거나, 공석 시 센터장이 팀장 결재를 대행할 수 있어요.`,'info',5000);
    }
    toast(makeActive?'재직 상태로 전환했습니다.':'퇴사(비활성) 처리했습니다. 해당 계정은 로그인할 수 없습니다.','success');
    await deps.refetchUsers(); deps.refresh();
  }catch(e){ toast('저장 오류: '+e.message,'error'); }
}

/**
 * 삭제 — 유형마다 경로가 다르다.
 *
 * 예전에는 컬렉션을 변수로 골라 셋을 한 줄로 처리했다. 그런데 users 는
 * 규칙이 클라이언트 쓰기를 막으므로 **직원 삭제가 조용히 실패했다**
 * (showConfirm 이 거부를 삼켰다). 변수로 고르면 어느 규칙이 걸리는지도
 * 읽을 수 없다.
 */
export function confirmDelete(type,id){
  const labels={client:'입주자',account:'계좌',staff:'직원'};
  showConfirm(labels[type]+' 삭제',labels[type]+'를 삭제하시겠습니까?',async()=>{
    // 무엇을 지웠는지 이름을 먼저 읽어 둔다 — 지운 뒤에는 알 수 없다.
    const nameOf={
      client:()=>(S.allClients||S.clients).find(c=>c.id===id)?.name,
      account:()=>(S.allAccounts||S.accounts).find(a=>a.id===id)?.label,
      staff:()=>S.users.find(u=>u.id===id)?.name,
    }[type];
    const target=(nameOf&&nameOf())||id;

    if(type==='staff'){   // 서버가 마지막 관리자 보호·담당 배정을 확인한다
      await window._fbFn.call('deleteStaff')({userId:id});
      await auditLog('staff.update',{resourceId:id,summary:{target,action:'삭제'}});
      await deps.refetchUsers();
    }else if(type==='client'){   // 서버가 투영본까지 함께 정리한다
      await window._fbFn.call('deleteClient')({clientId:id});
      await auditLog('client.delete',{resourceId:id,summary:{target}});
      await deps.refetchClients();
    }else{
      const{doc,deleteDoc}=fb();
      await deleteDoc(doc(fdb(),COLS.ACCOUNTS,id));
      await auditLog('account.delete',{resourceId:id,summary:{target}});
      await deps.refetchAccounts();
    }

    deps.refresh();
    toast('삭제됨','success');
  },'삭제','btn btn-danger');
}

