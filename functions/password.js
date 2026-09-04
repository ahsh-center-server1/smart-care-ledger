'use strict';

/**
 * 비밀번호 해시 — Node 내장 crypto.scrypt 사용.
 * 네이티브 빌드가 필요한 bcrypt 대신 내장 모듈을 써서 배포 의존성을 없앤다.
 *
 * 저장 형식(userSecrets/{userId}):
 *   { algo: 'scrypt', N, r, p, keylen, salt: <hex>, hash: <hex>, updatedAt }
 */

const crypto = require('crypto');

// scrypt 파라미터. N을 올리면 느려지지만 무차별 대입에 강해진다.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    // maxmem 기본값(32MB)은 N=16384, r=8에 부족하므로 넉넉히 지정한다.
    const opts = { N, r, p, maxmem: 256 * 1024 * 1024 };
    crypto.scrypt(password, salt, keylen, opts, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

/** 평문 → 저장용 해시 레코드 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return {
    algo: 'scrypt',
    ...PARAMS,
    salt: salt.toString('hex'),
    hash: key.toString('hex'),
  };
}

/**
 * 평문과 저장된 레코드를 비교한다.
 * 타이밍 공격을 막기 위해 timingSafeEqual을 쓴다.
 */
async function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt' || !record.salt || !record.hash) return false;
  const params = {
    N: record.N || PARAMS.N,
    r: record.r || PARAMS.r,
    p: record.p || PARAMS.p,
    keylen: record.keylen || PARAMS.keylen,
  };
  let key;
  try {
    key = await scrypt(password, Buffer.from(record.salt, 'hex'), params);
  } catch (_) {
    return false;
  }
  const expected = Buffer.from(record.hash, 'hex');
  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 확인한다.
  if (key.length !== expected.length) return false;
  return crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword, PARAMS };
