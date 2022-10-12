const jwtServer = require("jsonwebtoken");
var jwksClient = require("jwks-rsa");
const mongo = require("./mongodb");

var client = jwksClient({
  jwksUri: "https://id.yourdomain.com/jwks",
});
function getKey(header, callback) {
  client.getSigningKey(header.kid, function (err, key) {
    if (key) {
      var signingKey = key.publicKey || key.rsaPublicKey;
      callback(null, signingKey);
    } else {
      callback(null, null);
    }
  });
}

function verifyToken(JWT, verifyUserExistance = true) {
  return new Promise((res, rej) => {
    if (!JWT) {
      if (verifyUserExistance == true) rej("No token provided");
      if (verifyUserExistance == false) res(false);
    }

    jwtServer.verify(JWT, getKey, {}, async function (err, decoded) {
      if (err) {
        if (verifyUserExistance == true) rej(err);
        if (verifyUserExistance == false) res(false);
        return;
      }

      if (verifyUserExistance == true) {
        const userCollection = mongo().collection("users");
        const users = await userCollection.find({}).toArray();

        var user = users.find((u) => u.code == decoded.sub);

        if (!user) {
          const userObject = {
            code: decoded.sub,
            username: decoded.username,
            firstName: decoded.first_name,
            lastName: decoded.last_name,
            email: decoded.email,
            isAdmin: false,
            balance: 0,
          };

          try {
            await userCollection.insertOne(userObject);
          } catch (e) {}
          const users = await userCollection.find({}).toArray();
          user = users.find((u) => u.code == decoded.sub);
        }

        res(user);
      } else {
        res(true);
      }
    });
  });
}

module.exports = verifyToken;
