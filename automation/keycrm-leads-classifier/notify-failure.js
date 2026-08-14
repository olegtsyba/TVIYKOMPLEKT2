require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { notify } = require('../notify');

const message = process.argv.slice(2).join(' ');
notify(message).then(() => process.exit(0));
