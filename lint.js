#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findJsFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(findJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }

  return files;
}

// Get all .js files in public/ recursively
const files = findJsFiles('public').sort();

if (files.length === 0) {
  console.log('No .js files found');
  process.exit(0);
}

let failed = false;

for (const file of files) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
    console.log(`OK: ${file}`);
  } catch (error) {
    console.log(`FAIL: ${file}`);
    console.log(`  ${error.message}`);
    failed = true;
  }
}

if (!failed) {
  console.log('All OK');
  process.exit(0);
} else {
  process.exit(1);
}
