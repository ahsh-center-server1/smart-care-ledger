// test/rules/firestore-rules.test.mjs
//
// firestore.rules 단위 테스트 — Firestore 에뮬레이터에서 규칙을 실제로 평가한다.
//
// ⚠️ 왜 이 파일이 필요한가
//    RUNBOOK.md의 「배포 3」(규칙 잠금)은 되돌리기가 가장 어려운 단계다. 잘못 적용하면
//    전원이 로그인 불가가 되고, 너무 느슨하면 열린 채로 운영에 나간다. 그런데 이 규칙은
//    지금까지 **한 번도 평가된 적이 없다**. 배포가 첫 실행이 되면 안 된다.
//
// 실행: npm run test:rules   (에뮬레이터를 자동으로 띄우고 끈다)
//
// 규칙은 클레임 { role, isAdmin }과 uid만 본다(문서 조회 없음) — 그래서 시드 없이도
// 권한 판정을 전수 검증할 수 있고, 20-doc-access 예산 문제도 애초에 없다.

import { after, before, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, getDocs, query, where,
} from 'firebase/firestore';

const HOST = '127.0.0.1';
const PORT = 8080;

/** 역할별 컨텍스트를 만든다. 규칙이 보는 것은 uid와 이 두 클레임뿐이다. */
const ACTORS = {
  입력자: { uid: 'staff-input', role: '입력자', isAdmin: false },
  담당자: { uid: 'staff-owner', role: '담당자', isAdmin: false },
  팀장:   { uid: 'staff-leader', role: '팀장',  isAdmin: false },
  센터장: { uid: 'staff-center', role: '센터장', isAdmin: false },
  관리자: { uid: 'staff-admin',  role: '관리자', isAdmin: true },
};

/** role 클레임이 등급표에 없는 값 → rank() 0 → fail-closed 여야 한다. */
const UNKNOWN_ROLE = { uid: 'staff-weird', role: '알수없는역할', isAdmin: false };
/** role 클레임이 아예 없는 토큰 → 마찬가지로 0. */
const NO_ROLE_CLAIM = { uid: 'staff-noclaim' };

let testEnv;

/** 로그인한 사용자의 Firestore 핸들. */
function as(actor) {
  const { uid, ...claims } = actor;
  return testEnv.authenticatedContext(uid, claims).firestore();
}

/** 비로그인 Firestore 핸들. */
function asAnon() {
  return testEnv.unauthenticatedContext().firestore();
}

/** 규칙을 우회해 문서를 심는다(읽기/수정/삭제 테스트의 사전 조건용). */
async function seed(path, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'smart-care-ledger-rules-test',
    firestore: {
      host: HOST,
      port: PORT,
      rules: readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8'),
    },
  });
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

// ─────────────────────────────────────────────────────────────
// 비로그인 — 아무것도 못 한다
//
// 규칙 잠금 전 상태(`allow read, write: if request.time < 2030-12-31`)에서는
// URL만 알면 전체 DB를 읽고 쓸 수 있었다. 그것이 실제로 막혔는지가 이 파일의 존재 이유다.
// ─────────────────────────────────────────────────────────────
describe('비로그인 클라이언트', () => {
  const COLLECTIONS = [
    'users', 'clients', 'accounts', 'transactions', 'categories',
    'fixedItems', 'reports', 'budgets', 'excelUploads', 'config',
    'userSecrets', 'archive_2025',
  ];

  for (const col of COLLECTIONS) {
    it(`${col} 를 읽을 수 없다`, async () => {
      await seed(`${col}/probe`, { hello: 'world' });
      await assertFails(getDoc(doc(asAnon(), `${col}/probe`)));
    });

    it(`${col} 에 쓸 수 없다`, async () => {
      await assertFails(setDoc(doc(asAnon(), `${col}/anon-write`), { x: 1 }));
    });

    it(`${col} 목록을 조회할 수 없다`, async () => {
      await assertFails(getDocs(collection(asAnon(), col)));
    });
  }
});

// ─────────────────────────────────────────────────────────────
// userSecrets — 비밀번호 해시. 어떤 클라이언트로도 접근 불가.
//
// 마이그레이션의 핵심 목적이 「평문 비밀번호를 브라우저에서 없앤다」이므로
// 관리자 토큰으로도 열리면 안 된다. Functions만 Admin SDK로 우회한다.
// ─────────────────────────────────────────────────────────────
describe('userSecrets — 클라이언트 전면 차단', () => {
  before(async () => {
    await seed('userSecrets/staff-admin', { hash: 'scrypt$...', salt: 'x' });
  });

  for (const [name, actor] of Object.entries(ACTORS)) {
    it(`${name}도 읽을 수 없다`, async () => {
      await assertFails(getDoc(doc(as(actor), 'userSecrets/staff-admin')));
    });

    it(`${name}도 쓸 수 없다`, async () => {
      await assertFails(setDoc(doc(as(actor), 'userSecrets/staff-admin'), { hash: 'pwned' }));
    });

    it(`${name}도 삭제할 수 없다`, async () => {
      await assertFails(deleteDoc(doc(as(actor), 'userSecrets/staff-admin')));
    });
  }

  it('관리자도 목록을 조회할 수 없다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.관리자), 'userSecrets')));
  });
});

// ─────────────────────────────────────────────────────────────
// users — 읽기는 로그인 전원, 쓰기는 Functions 전용
//
// 앱이 팀장·결재자 이름을 찾기 위해 users를 로드하므로 읽기는 열려 있다.
// 다만 역할 변경·승인·비밀번호를 클라이언트가 건드리면 권한 상승이 되므로 쓰기는 전면 차단.
// ─────────────────────────────────────────────────────────────
describe('users', () => {
  before(async () => {
    await seed('users/staff-owner', { userId: 'staff-owner', name: '홍길동', role: '담당자' });
  });

  it('입력자도 읽을 수 있다 (내부 인명부)', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'users/staff-owner')));
  });

  it('관리자조차 쓸 수 없다 — 역할 상승 경로 차단', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.관리자), 'users/staff-owner'), { role: '센터장' }),
    );
  });

  it('본인 문서도 스스로 수정할 수 없다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.담당자), 'users/staff-owner'), { name: '개명' }),
    );
  });

  it('새 직원을 클라이언트에서 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.관리자), 'users/newbie'), { userId: 'newbie', role: '관리자' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// clients · accounts — 조회는 전원, 변경은 팀장(3) 이상
// ─────────────────────────────────────────────────────────────
describe('clients · accounts', () => {
  before(async () => {
    await seed('clients/c1', { name: '김입주', userIds: 'staff-owner' });
    await seed('accounts/a1', { clientId: 'c1', label: '생활비', initialBalance: 0 });
  });

  for (const col of ['clients', 'accounts']) {
    const id = col === 'clients' ? 'c1' : 'a1';

    it(`${col}: 입력자도 읽을 수 있다`, async () => {
      await assertSucceeds(getDoc(doc(as(ACTORS.입력자), `${col}/${id}`)));
    });

    it(`${col}: 담당자는 변경할 수 없다`, async () => {
      await assertFails(updateDoc(doc(as(ACTORS.담당자), `${col}/${id}`), { memo: 'x' }));
    });

    it(`${col}: 팀장은 변경할 수 있다`, async () => {
      await assertSucceeds(updateDoc(doc(as(ACTORS.팀장), `${col}/${id}`), { memo: 'ok' }));
    });

    it(`${col}: 센터장은 변경할 수 있다`, async () => {
      await assertSucceeds(updateDoc(doc(as(ACTORS.센터장), `${col}/${id}`), { memo: 'ok2' }));
    });

    it(`${col}: 관리자는 변경할 수 있다`, async () => {
      await assertSucceeds(updateDoc(doc(as(ACTORS.관리자), `${col}/${id}`), { memo: 'ok3' }));
    });
  }
});

// ─────────────────────────────────────────────────────────────
// transactions — 입력자는 본인이 만든 것만
//
// 이 앱에서 가장 민감한 규칙이다. 입력자가 남의 금전 거래를 보지 못해야 하고,
// 목록 조회는 클라이언트가 where('createdBy','==',uid)를 함께 걸어야 통과한다
// (규칙 엔진이 결과 전체의 조건 충족을 증명할 수 없으면 쿼리를 통째로 거부한다).
// core.js:189가 실제로 그 필터를 건다 — 아래 두 테스트가 그 계약을 고정한다.
// ─────────────────────────────────────────────────────────────
describe('transactions', () => {
  before(async () => {
    await seed('transactions/t-mine',   { clientId: 'c1', date: '2026-09-01', amountOut: 1000, createdBy: 'staff-input' });
    await seed('transactions/t-others', { clientId: 'c1', date: '2026-09-02', amountOut: 2000, createdBy: 'staff-owner' });
  });

  it('입력자는 본인이 만든 거래를 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'transactions/t-mine')));
  });

  it('입력자는 남이 만든 거래를 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'transactions/t-others')));
  });

  it('입력자는 남이 만든 거래를 수정할 수 없다', async () => {
    await assertFails(
      updateDoc(doc(as(ACTORS.입력자), 'transactions/t-others'), { amountOut: 1 }),
    );
  });

  it('입력자는 남이 만든 거래를 삭제할 수 없다', async () => {
    await assertFails(deleteDoc(doc(as(ACTORS.입력자), 'transactions/t-others')));
  });

  it('입력자의 무필터 목록 조회는 거부된다', async () => {
    await assertFails(getDocs(collection(as(ACTORS.입력자), 'transactions')));
  });

  it('입력자가 createdBy 필터를 걸면 목록 조회가 통과한다 (core.js:189의 계약)', async () => {
    const q = query(
      collection(as(ACTORS.입력자), 'transactions'),
      where('createdBy', '==', 'staff-input'),
    );
    await assertSucceeds(getDocs(q));
  });

  it('입력자가 남의 uid로 필터를 걸면 거부된다', async () => {
    const q = query(
      collection(as(ACTORS.입력자), 'transactions'),
      where('createdBy', '==', 'staff-owner'),
    );
    await assertFails(getDocs(q));
  });

  it('담당자는 전체 목록을 조회할 수 있다', async () => {
    await assertSucceeds(getDocs(collection(as(ACTORS.담당자), 'transactions')));
  });

  it('거래 생성 시 createdBy는 본인이어야 한다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.입력자), 'transactions/t-new-ok'), {
        clientId: 'c1', date: '2026-09-03', amountOut: 500, createdBy: 'staff-input',
      }),
    );
  });

  it('createdBy를 남의 uid로 위조해 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.입력자), 'transactions/t-forged'), {
        clientId: 'c1', date: '2026-09-03', amountOut: 500, createdBy: 'staff-owner',
      }),
    );
  });

  it('createdBy 없이 만들 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.담당자), 'transactions/t-nocreator'), {
        clientId: 'c1', date: '2026-09-03', amountOut: 500,
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// reports — 입력자는 접근 불가 (등급 2 이상)
// ─────────────────────────────────────────────────────────────
describe('reports', () => {
  before(async () => {
    await seed('reports/r1', { clientId: 'c1', year: 2026, month: 9, status: 'draft' });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'reports/r1')));
  });

  it('입력자는 쓸 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.입력자), 'reports/r1'), { status: 'confirmed' }));
  });

  it('담당자는 읽고 쓸 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'reports/r1')));
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'reports/r1'), { status: 'submitted' }));
  });
});

// ─────────────────────────────────────────────────────────────
// budgets — 조회 담당자(2) 이상, 변경 팀장(3) 이상
// ─────────────────────────────────────────────────────────────
describe('budgets', () => {
  before(async () => {
    await seed('budgets/b1', { clientId: 'c1', year: 2026, categoryBudgets: {} });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'budgets/b1')));
  });

  it('담당자는 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'budgets/b1')));
  });

  it('담당자는 변경할 수 없다', async () => {
    await assertFails(updateDoc(doc(as(ACTORS.담당자), 'budgets/b1'), { note: 'x' }));
  });

  it('팀장은 변경할 수 있다', async () => {
    await assertSucceeds(updateDoc(doc(as(ACTORS.팀장), 'budgets/b1'), { note: 'ok' }));
  });
});

// ─────────────────────────────────────────────────────────────
// categories · fixedItems · excelUploads — 담당자(2) 이상 편집
// ─────────────────────────────────────────────────────────────
describe('categories · fixedItems', () => {
  before(async () => {
    await seed('categories/cat1', { category: '식비', type: '지출' });
    await seed('fixedItems/f1', { clientId: 'c1', amount: 30000, day: 5 });
  });

  for (const [col, id] of [['categories', 'cat1'], ['fixedItems', 'f1']]) {
    it(`${col}: 입력자도 읽을 수 있다`, async () => {
      await assertSucceeds(getDoc(doc(as(ACTORS.입력자), `${col}/${id}`)));
    });

    it(`${col}: 입력자는 쓸 수 없다`, async () => {
      await assertFails(updateDoc(doc(as(ACTORS.입력자), `${col}/${id}`), { x: 1 }));
    });

    it(`${col}: 담당자는 쓸 수 있다`, async () => {
      await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), `${col}/${id}`), { x: 1 }));
    });
  }
});

describe('excelUploads', () => {
  before(async () => {
    await seed('excelUploads/e1', { accId: 'a1', filename: 'kb.xls', count: 10 });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'excelUploads/e1')));
  });

  it('담당자는 읽고 쓸 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'excelUploads/e1')));
    await assertSucceeds(updateDoc(doc(as(ACTORS.담당자), 'excelUploads/e1'), { count: 11 }));
  });
});

// ─────────────────────────────────────────────────────────────
// config — 관리자 전용, 단 연도 마감 이력은 센터장(4)도
//
// 이 예외가 없으면 센터장이 마감을 시작하는 순간 이력 쓰기에서 거부된다.
// firestore.rules:93의 그 카브아웃이 실제로 동작하는지 확인한다.
// ─────────────────────────────────────────────────────────────
describe('config', () => {
  before(async () => {
    await seed('config/permissions', { schema: 'minRank' });
    await seed('config/archive_2025', { type: 'archive', year: 2025, count: 100 });
  });

  it('입력자도 읽을 수 있다 (권한 등급표 로드)', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.입력자), 'config/permissions')));
  });

  it('센터장은 권한 등급표를 바꿀 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/permissions'), { schema: 'minRank', hacked: true }),
    );
  });

  it('관리자는 권한 등급표를 바꿀 수 있다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.관리자), 'config/permissions'), { schema: 'minRank' }),
    );
  });

  it('센터장은 마감 이력(archive_YYYY)을 쓸 수 있다 — 마감이 거부되지 않아야 한다', async () => {
    await assertSucceeds(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_2026'), {
        type: 'archive', year: 2026, count: 42,
      }),
    );
  });

  it('팀장은 마감 이력을 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.팀장), 'config/archive_2026'), { type: 'archive', year: 2026 }),
    );
  });

  it('archive 를 닮았지만 형식이 다른 id는 센터장이 쓸 수 없다', async () => {
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_20xx'), { x: 1 }),
    );
    await assertFails(
      setDoc(doc(as(ACTORS.센터장), 'config/archive_202'), { x: 1 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────
// archive_YYYY 컬렉션 — 조회 담당자(2) 이상, 쓰기 센터장(4) 이상
//
// 컬렉션명이 동적이라 match /{col}/{id} + 정규식으로 판별한다.
// 와일드카드가 다른 컬렉션까지 열어버리지 않는지가 관건.
// ─────────────────────────────────────────────────────────────
describe('archive_YYYY 컬렉션', () => {
  before(async () => {
    await seed('archive_2025/t1', { clientId: 'c1', date: '2025-05-01', amountOut: 1000 });
  });

  it('입력자는 읽을 수 없다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.입력자), 'archive_2025/t1')));
  });

  it('담당자는 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as(ACTORS.담당자), 'archive_2025/t1')));
  });

  it('팀장은 쓸 수 없다', async () => {
    await assertFails(setDoc(doc(as(ACTORS.팀장), 'archive_2025/t2'), { x: 1 }));
  });

  it('센터장은 쓸 수 있다 (마감이 여기에 복사한다)', async () => {
    await assertSucceeds(setDoc(doc(as(ACTORS.센터장), 'archive_2025/t3'), { x: 1 }));
  });

  it('와일드카드가 임의 컬렉션을 열지 않는다', async () => {
    await seed('randomStuff/x1', { secret: 1 });
    await assertFails(getDoc(doc(as(ACTORS.관리자), 'randomStuff/x1')));
    await assertFails(setDoc(doc(as(ACTORS.관리자), 'randomStuff/x2'), { y: 1 }));
  });

  it('와일드카드가 userSecrets를 열지 않는다', async () => {
    await assertFails(getDoc(doc(as(ACTORS.센터장), 'userSecrets/staff-admin')));
  });
});

// ─────────────────────────────────────────────────────────────
// fail-closed — 모르는 역할, 클레임 없는 토큰
//
// rank()는 등급표에 없는 role을 0으로 떨어뜨린다. 토큰을 위조하거나
// 마이그레이션이 덜 된 계정이 담당자 권한을 얻으면 안 된다.
// ─────────────────────────────────────────────────────────────
describe('fail-closed — 알 수 없는 역할', () => {
  before(async () => {
    await seed('reports/r-fc', { clientId: 'c1', year: 2026, month: 9 });
    await seed('clients/c-fc', { name: 'x' });
  });

  for (const [label, actor] of [['모르는 역할', UNKNOWN_ROLE], ['role 클레임 없음', NO_ROLE_CLAIM]]) {
    it(`${label}: 보고서에 접근할 수 없다`, async () => {
      await assertFails(getDoc(doc(as(actor), 'reports/r-fc')));
    });

    it(`${label}: 입주자를 변경할 수 없다`, async () => {
      await assertFails(updateDoc(doc(as(actor), 'clients/c-fc'), { memo: 'x' }));
    });

    it(`${label}: 로그인은 되어 있으므로 인명부는 읽을 수 있다`, async () => {
      // signedIn()만 요구하는 리소스는 통과한다 — 등급이 0이어도 로그인 자체는 유효하다.
      await assertSucceeds(getDoc(doc(as(actor), 'clients/c-fc')));
    });

    it(`${label}: 본인이 만든 거래는 다룰 수 있다`, async () => {
      await assertSucceeds(
        setDoc(doc(as(actor), `transactions/t-fc-${actor.uid}`), {
          clientId: 'c-fc', date: '2026-09-01', amountOut: 100, createdBy: actor.uid,
        }),
      );
    });
  }

  it('isAdmin 클레임이 문자열 "true"면 관리자로 인정되지 않는다', async () => {
    const spoofed = { uid: 'spoof', role: '입력자', isAdmin: 'true' };
    await assertFails(
      setDoc(doc(as(spoofed), 'config/permissions'), { schema: 'minRank', hacked: true }),
    );
  });

  it('isAdmin만 있고 role이 없어도 관리자 권한은 유효하다', async () => {
    // 관리자는 rank와 직교한다(ADMIN_RANK 99). 마이그레이션이 role을 못 채운
    // 관리자 계정이 잠기지 않아야 한다.
    const adminNoRole = { uid: 'admin-noRole', isAdmin: true };
    await assertSucceeds(
      setDoc(doc(as(adminNoRole), 'config/permissions'), { schema: 'minRank' }),
    );
  });
});
