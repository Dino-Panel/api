require("dotenv").config();
const { MongoClient } = require("mongodb");
const mongoUrl = process.env.MONGODB_URI;
const client = new MongoClient(mongoUrl);
var db;

async function connect() {
  await client.connect();
  db = client.db("panel");
  console.log(`[LOG] Connected to MongoDB`);
}

function getDb() {
  return db;
}

module.exports = getDb;
connect();
