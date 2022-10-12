var mysql = require("mysql");
var bcrypt = require("bcrypt");

var con = mysql.createConnection({
  host: "",
  user: "",
  password: "",
  database: "",
});

var con2 = mysql.createConnection({
  host: "",
  user: "",
  password: "",
  database: "",
});

con.connect();
con2.connect();

setTimeout(() => {
  var sql = "SELECT * FROM `users`";

  con2.query(sql, function (err, result) {
    if (err) throw err;

    const ccPanelUsers = result;

    con.query(sql, function (err, result) {
      if (err) throw err;

      const idUsers = result;

      for (var idUser of idUsers) {
        const ptUser = ccPanelUsers.find((u) => u.username == idUser.username);

        const idDbRowId = idUser.id;

        if (ptUser) {
          console.log(idDbRowId, ptUser);

          con.query(
            `UPDATE users SET email='${ptUser.email}',first_name='${ptUser.first_name}',last_name='${ptUser.last_name}',phone_number='${ptUser.phone_number}' WHERE id = '${idDbRowId}'`,
            function (err, result) {
              if (err) {
                return;
              }
              console.log("Updated");
            }
          );
        }
      }
    });
  });
}, 500);
