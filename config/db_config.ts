// var mysql = require('mysql')
// var connection = mysql.createConnection({
//    host: '103.171.180.110',
//    user: 'nwints_user',
//    password: 'Password786@',
//    database: 'nwints_bot'
// })

// connection.connect(function(err:any) {
//     if (err){ 
//         throw err;
//     }else{
//         console.log('DB connected');
//     }
// });

// module.exports = connection;
// config/db_config.ts
import mysql from 'mysql';

const db = mysql.createConnection({
   host: '103.171.180.110',
   user: 'nwints_user',
   password: 'Password786@',
   database: 'nwints_bot'
});

db.connect((err) => {
  if (err) {
    console.error('DB connection error:', err);
  } else {
    console.log('Connected to MySQL database.');
  }
});

// ✅ Export to make this file a module
export default db;
