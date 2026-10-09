const { Client } = require('pg');
const c = new Client({ connectionString: 'postgresql://postgres:Hello@localhost:5432/email_campaigns' });
c.connect()
  .then(() => c.query("select id, user_id, from_email, daily_email_limit from smtp_settings where from_email = 'ja5523517@gmail.com'"))
  .then(r => { console.log(r.rows); return c.end(); })
  .catch(e => console.log(e.message));