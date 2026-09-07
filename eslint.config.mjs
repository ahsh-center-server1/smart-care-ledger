/**
 * ESLint 설정 — Smart Care Ledger
 *
 * 왜 필요한가
 *   기존 `npm run lint`는 `node --check`를 도는 **문법 검사**였다. 오타난 함수명,
 *   없는 변수, 잘못된 전역 참조를 전혀 못 잡는다. 이 앱은 HTML `onclick`이 함수
 *   이름을 문자열로 참조하는 전역 100여 개에 의존하므로, 이름이 하나만 어긋나도
 *   런타임에 조용히 죽는다. `no-undef`가 그것을 배포 전에 잡아주는 유일한 장치다.
 *
 * 규칙은 최소로 유지한다 — 스타일 규칙을 켜면 기존 코드 전체가 경고로 뒤덮여
 * 정작 중요한 no-undef가 묻힌다. 잡고 싶은 것은 "실제로 터지는 것"뿐이다.
 */

import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'functions/node_modules/**',
      'public/lib/**',
      // 외부 라이브러리 결과물 — tools/vendor.mjs가 npm에서 만들어 넣는다.
      // 우리 코드가 아니고 minify돼 있어 검사할 것도, 고칠 수도 없다.
      'public/vendor/**',
      // 화면 검증 산출물(스크린샷·요약)
      'qa-artifacts/**',
    ],
  },

  // ── 브라우저 ES 모듈 (public/) ──
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // CDN으로 로드되는 전역들 — index.html의 <script>가 넣어준다
        XLSX: 'readonly',
        Chart: 'readonly',
        firebase: 'readonly',
        heic2any: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      // 같은 이름의 함수를 두 번 정의하면 뒤엣것이 조용히 이긴다.
      // CLAUDE.md의 "함수 중복 절대 금지"를 사람 눈 대신 여기서 지킨다.
      'no-func-assign': 'error',
      'no-redeclare': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'require-atomic-updates': 'off',
    },
  },

  // ── 서비스 워커 ──
  {
    files: ['public/sw.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
  },

  // ── Cloud Functions (CommonJS, Node) ──
  {
    files: ['functions/**/*.js', 'functions/**/*.cjs', '*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // ── 도구·테스트 (Node ESM) ──
  {
    files: ['tools/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },

  // ── 브라우저 안에서 실행되는 코드를 품은 Node 스크립트 ──
  // qa-smoke.mjs는 Node에서 돌지만 page.evaluate(() => window...) 콜백은
  // 브라우저 컨텍스트에서 실행된다. 그 window는 진짜 전역이므로 선언해 준다.
  {
    files: ['tools/qa-smoke.mjs'],
    languageOptions: {
      globals: { ...globals.node, window: 'readonly' },
    },
  },
];
