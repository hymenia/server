const bcrypt = require('bcryptjs');

let rounds = 10;

async function hashPassword(password) {
  return bcrypt.hash(password, rounds);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

const DUMMY_HASH = bcrypt.hashSync('dummy', rounds);

module.exports = { hashPassword, comparePassword, DUMMY_HASH };
