const express = require("express");
var cors = require("cors");
var bodyParser = require("body-parser");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const { generators, Issuer } = require("openid-client");
const code_verifier = generators.codeVerifier();
const pterodactyl = require("./pterodactyl");
const { default: axios } = require("axios");
var path = require("path");
var randomMac = require("random-mac");
const fs = require("fs");
const { exec } = require("child_process");
require("dotenv").config();

const privateServers = require("./private_server");
const paypal = require("./paypal");
const invoices = require("./invoices");
var mongo = require("./mongodb");
var session = require("./session");

var qemuSockets = [];

var serverPort = 3000;
if (
  process.env.PRODUCTION_MODE != true &&
  process.env.PRODUCTION_MODE != "true"
) {
  serverPort = 3001;
}


//send update just in case something somewhere didn't work (every 24H)
setInterval(() => {
  //send update to all servers that use private certificates
  io.to("serverNode").emit("updatePrivateCertificate");
}, 24 * 60 * 60 * 1000);

//recreateCertificate();

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(bodyParser.json({ extended: false }));
app.use("/", function (req, res, next) {
  if (
    req.url.includes("/paypal/transactionbackend") == true ||
    req.url.includes("/sys/certs/privateservers") == true ||
    req.url.includes("/qemu/completeinstall/")
  ) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    authUrlResponse();
    return;
  }
  const token = authHeader?.split(" ")[1];

  session(token)
    .then((user) => {
      res.locals.user = user;
      next();
    })
    .catch((e) => {
      authUrlResponse();
    });

  function authUrlResponse() {
    Issuer.discover("https://id.yourdomain.com").then(function (diskosIssuer) {
      const client = new diskosIssuer.Client({
        client_id: "dp-panelv3-diskcraft",
        redirect_uri: ["https://billing.yourdomain.com/oidc_return"], // using jwt.io as redirect_uri to show the ID Token contents
        response_type: ["id_token"],
        grant_type: ["implicit"],
      });

      const code_challenge = generators.codeChallenge(code_verifier);

      var authUrl = client.authorizationUrl({
        scope: "openid email profile verification",
        code_challenge,
        code_challenge_method: "S256",
        nonce: randomNonce(1024),
      });
      res.status(401).json({
        redirect_url: authUrl,
      });
    });
  }
});

app.use("/admin/", function (req, res, next) {
  var isAdmin = res?.locals?.user?.isAdmin || false;

  if (isAdmin == true) {
    next();
  } else {
    res.status(403).json("Missing ADMIN permission");
  }
});

const io = new Server(server, {
  allowEIO3: true,
  cors: {
    credentials: true, // This is important.
    origin: (origin, callback) => {
      return callback(null, true);
    },
  },
});

var dockerMetricsCache = [];
var qemuVpsMetricsCache = [];
io.on("connection", (socket) => {
  var username = null;
  socket.emit("connectNotification");

  socket.on("registerAsClient", async (data) => {
    const usersCollection = mongo().collection("users");
    const validJwt = await session(data.jwt, false);

    if (validJwt == true) {
      const users = await usersCollection.find({}).toArray();
      const user = users.find((u) => u.code == data.sub);
      if (!user) {
        var jwtData = data.jwt.split(".");
        jwtData = atob(jwtData[1]);
        jwtData = JSON.parse(jwtData);
        console.log(jwtData);
        //create user
      } else {
        var jwtData = data.jwt.split(".");
        jwtData = Buffer.from(jwtData[1], "base64");
        jwtData = JSON.parse(jwtData);

        if (
          jwtData.first_name != user.firstName ||
          jwtData.last_name != user.lastName ||
          jwtData.email != user.email
        ) {
          const updateObject = {
            firstName: jwtData.first_name,
            lastName: jwtData.last_name,
            email: jwtData.email,
          };

          await usersCollection.updateOne(
            {
              code: user.code,
            },
            {
              $set: updateObject,
            }
          );
        }

        username = user.username;
        console.log(`[SOCKET] ${user.username} connected`);
        if (user.isAdmin) {
          socket.join("admin");
        }
        socket.join(data.sub);
      }
    }

    //"23121d3c-84df-44ac-b458-3d63a9a05497"
  });

  socket.on("registerAsServer", () => {
    socket.join("serverNode");

    var nodeId;
    var staticNodeId;
    socket.on("dockerMetrics", (dockerMetrics) => {
      var existingDockerMetricsEntry = dockerMetricsCache.find(
        (met) => met.nodeId == dockerMetrics.nodeId
      );
      nodeId = dockerMetrics.nodeId;
      if (existingDockerMetricsEntry) {
        var existingDockerMetricsEntryIndex = dockerMetricsCache.indexOf(
          existingDockerMetricsEntry
        );
        dockerMetricsCache.splice(existingDockerMetricsEntryIndex, 1);
      }
      dockerMetricsCache.push(dockerMetrics);
    });

    socket.on("qemuInstallStatusUpdate", async (data) => {
      const serversCollection = mongo().collection("qemuServers");
      await serversCollection.updateOne(
        { qemuCode: data.code },
        {
          $set: {
            status: data.status,
          },
        }
      );
    });

    socket.on("qemuServers", (qemuServers) => {
      nodeId = qemuServers.nodeId;
      staticNodeId = qemuServers.staticNodeId;

      var existingSocketEntry = qemuSockets.find((s) => s.id == staticNodeId);

      if (!existingSocketEntry) {
        qemuSockets.push({
          id: staticNodeId,
          socket: socket,
        });
      }

      var existingQemuMetricsEntry = qemuVpsMetricsCache.find(
        (met) => met.nodeId == qemuServers.nodeId
      );
      if (existingQemuMetricsEntry) {
        var existingQemuMetricsEntryIndex = qemuVpsMetricsCache.indexOf(
          existingQemuMetricsEntry
        );
        qemuVpsMetricsCache.splice(existingQemuMetricsEntryIndex, 1);
      }
      qemuVpsMetricsCache.push(qemuServers);
    });

    socket.on("disconnect", function () {
      var existingQemuMetricsEntry = qemuVpsMetricsCache.find(
        (met) => met.nodeId == nodeId
      );
      if (existingQemuMetricsEntry) {
        var existingQemuMetricsEntryIndex = qemuVpsMetricsCache.indexOf(
          existingQemuMetricsEntry
        );
        qemuVpsMetricsCache.splice(existingQemuMetricsEntryIndex, 1);
      }

      const existingDockerMetricsEntry = dockerMetricsCache.find(
        (met) => met.nodeId == nodeId
      );
      const existingDockerMetricsEntryIndex = dockerMetricsCache.indexOf(
        existingDockerMetricsEntry
      );
      dockerMetricsCache.splice(existingDockerMetricsEntryIndex, 1);

      var existingSocketEntry = qemuSockets.find((s) => s.id == staticNodeId);
      var existingSocketEntryIndex = qemuSockets.indexOf(existingSocketEntry);
      qemuSockets.splice(existingSocketEntryIndex, 1);
    });
  });

  socket.on("disconnect", function () {
    if (username) console.log(`[SOCKET] ${username} disconnected`);
  });
});

// setInterval(() => {
//   console.log(qemuVpsMetricsCache[0].list);
// }, 1000);

const locations = [
  {
    code: "can1",
    name: "Unknown, Canada",
    flag_url: "/img/flags/ca.png",
    id: 1,
  },
  {
    code: "de1",
    name: "Falkenstein, Germany",
    flag_url: "/img/flags/de.png",
    id: 2,
  },
];

var qemuServersCache = [];

async function updateQemuServersCache() {
  const serversCollection = mongo().collection("qemuServers");
  const allocationsCollection = mongo().collection("qemuAllocations");
  const servers = await serversCollection.find({}).toArray();
  const allocations = await allocationsCollection.find({}).toArray();
  var listAllQemuMetrics = [];
  var listAllFirewallRules = [];

  var processedServerList = [];

  for (var node of qemuVpsMetricsCache) {
    listAllQemuMetrics = [...listAllQemuMetrics, ...node.list];
    listAllFirewallRules = [...listAllFirewallRules, ...node.firewall];
  }

  var activityCollection = mongo().collection("qemuActivity");

  for (var server of servers) {
    const allocation = allocations.find((a) => a.code == server.allocationId);
    const metrics = listAllQemuMetrics.find((mi) => mi.name == server.qemuCode);
    var state = 1;
    var stateText = "Searching";

    const ipv4 = allocation?.dhcp?.ipv4 || allocation?.address?.private_ipv4;

    const firewallRules = listAllFirewallRules.filter(
      (r) => r.nodeId == allocation.node && r.private_ip == ipv4
    );

    var activity = await activityCollection
      .find({
        server: server.code,
      })
      .toArray();

    activity.reverse();

    var activityItems = [];
    var i = 0;

    for (var act of activity) {
      if (i < 6) {
        delete act._id;
        delete act.code;

        activityItems.push(act);
      }
      i++;
    }

    if (server.status.installed == false) {
      state = 0;
      stateText = "Installing";
    } else if (metrics?.suspended == true || server?.suspended == true) {
      state = 3;
      stateText = "Suspended";
    } else if (metrics?.online == true) {
      state = 5;
      stateText = "Running";
    } else if (metrics?.online == false) {
      state = 4;
      stateText = "Offline";
    }
    var priceIndex = server?.priceIndex || 1;

    var serverObject = {
      code: server.code,
      name: server.name,
      renewal: server.renewal,
      price: server.price * priceIndex,
      billingInterval: server?.billingInterval || 1,
      user: server.user,

      renew_cancel_date: server.renewDate,
      state,
      stateText,
      iso_mount: metrics?.iso_mount || null,
      status: server.status,
      novnc: server.novnc,
      activity: activityItems || [],
      specs: metrics?.specs || server.specs,
      cloudinit: server.cloudinit,
      location: locations.find((l) => l.id == allocation.location),
      network: allocation.dhcp || {
        ipv4: allocation.address.public_ipv4 || allocation.address.private_ipv4,
        ipv6: allocation.address.public_ipv6 || allocation.address.private_ipv6,
      },
      firewall_rules: firewallRules || [],
    };

    processedServerList.push(serverObject);
  }

  sendQemuChangeUpdate(processedServerList);

  setTimeout(() => {
    updateQemuServersCache();
  }, 100);
}

async function sendQemuChangeUpdate(newList) {
  const usersCollection = mongo().collection("users");
  const users = await usersCollection.find({}).toArray();

  const oldList = qemuServersCache;

  if (JSON.stringify(oldList) != JSON.stringify(newList)) {
    io.to("admin").emit("qemuServersUpdate.admin", newList);

    for (var user of users) {
      var serversListNew = newList.filter((u) => u.user == user.code);
      var serversListOld = oldList.filter((u) => u.user == user.code);

      if (JSON.stringify(serversListNew) != JSON.stringify(serversListOld)) {
        io.to(user.code).emit("qemuServersUpdate", serversListNew);
      }
    }
  }

  qemuServersCache = newList;
}

//PTERODACTYL

var pterodactylServerCache = [];
async function updatePterodactylServerCache() {
  const pterodactylServers = await pterodactyl.getServers();
  const nodes = await pterodactyl.getNodes();
  const serversCollection = mongo().collection("pterodactylServers");
  const servers = await serversCollection.find({}).toArray();

  var fullDockerMetricsList = {
    servers: [],
    statistics: [],
  };

  for (var node of dockerMetricsCache) {
    fullDockerMetricsList.servers = [
      ...fullDockerMetricsList.servers,
      ...node.cache.servers,
    ];
  }

  var ptServers = [];

  for (var dbServer of servers) {
    var server = pterodactylServers.find(
      (s) => s.attributes.external_id == dbServer.code
    );
    if (
      server &&
      (dbServer.showPlaceholderData == false ||
        server.attributes.container.installed == true)
    ) {
      var serverNode = nodes.find(
        (n) => n.attributes.id == server.attributes.node
      );
      var serverLocation = {};
      var serverState = 3;
      var serverInstallProgress = 100;
      serverLocation = locations.find(
        (l) => l.id == serverNode.attributes.location_id
      );

      var dockerMetricsServerItem = fullDockerMetricsList.servers.find(
        (s) => s.name == server.attributes.uuid
      );

      var serverStateText = "Unknown";

      if (server.attributes.container.installed == false) {
        serverState = 0;
        serverInstallProgress = 50;
        serverStateText = "Installing";
      } else if (server.attributes.suspended == true) {
        serverState = 3;
        serverStateText = "Suspended";
      } else if (dockerMetricsServerItem?.state == "running") {
        serverState = 5;
        serverStateText = "Running";
      } else {
        serverState = 4;
        serverStateText = "Offline";
      }

      var priceIndex = dbServer?.priceIndex || 1;

      var object = {
        name: server.attributes.name,
        user: server.attributes.user,
        uuid: dbServer.code,
        state: serverState,
        stateText: serverStateText,
        renewal: dbServer.renew,
        location: serverLocation,
        renewal_cancel_date: dbServer.renewDate,
        package: dbServer?.packageConfig?.code || "UNDEF1",
        price: dbServer.price * priceIndex,
        billingInterval: dbServer?.billingInterval || 1,
        manage_url:
          "https://billing.yourdomain.com/server/" + server.attributes.identifier,
        install_progress: serverInstallProgress,
        specs: {
          cpu: server.attributes.limits.cpu / 100,
          ram: server.attributes.limits.memory / 1024,
          disk: server.attributes.limits.disk / 1024,
        },
        suspended: server.attributes.suspended,
      };
      ptServers.push(object);
    } else {
      var serverLocation = {};
      if (dbServer.locationId == 1) {
        serverLocation = locations[0];
      }
      if (dbServer.locationId == 4) {
        serverLocation = locations[1];
      }

      if (dbServer.locationId == 5) {
        serverLocation = locations[2];
      }
      if (dbServer.locationId == 6) {
        serverLocation = locations[3];
      }
      if (dbServer.locationId == 7) {
        serverLocation = locations[4];
      }

      var priceIndex = dbServer?.priceIndex || 1;

      var object = {
        name: dbServer.placeholderData.displayName,
        user: dbServer.user,
        uuid: dbServer.code,
        state: 0,
        stateText: "Installing",
        package: dbServer?.packageConfig?.code || "UNDEF1",
        renewal: dbServer.renew,
        location: serverLocation,
        renewal_cancel_date: dbServer.renewDate,
        billingInterval: dbServer?.billingInterval || 1,
        price: dbServer.price * priceIndex,
        manage_url: null,
        install_progress: dbServer.placeholderData.installProgress,
        specs: dbServer.placeholderData.specs,
        suspended: false,
      };
      ptServers.push(object);
    }
  }

  sendPterodactylChangeUpdate(ptServers);

  setTimeout(() => {
    pterodactylServerCache = ptServers;
    updatePterodactylServerCache();
  }, 100);
}

async function sendPterodactylChangeUpdate(listNew1) {
  const listOld = pterodactylServerCache;
  const listNew = listNew1;
  const userCollection = mongo().collection("users");
  const users = await userCollection.find({}).toArray();

  if (JSON.stringify(listNew) == JSON.stringify(listOld)) {
    return;
  }

  var serversL = [];
  for (var serverT of listNew) {
    var server = Object.assign({}, serverT);
    const serverUser = users.find((u) => u.pterodactylId == server.user);
    if (serverUser) {
      server.user = serverUser;
      delete server.user._id;
    }

    serversL.push(server);
  }

  io.to("admin").emit("pterodactylServersUpdate.admin", serversL);

  for (var user of users) {
    if (user.pterodactylId != null) {
      var serversInOldList = listOld.filter(
        (s) => s.user == user.pterodactylId
      );
      var serversInNewList = listNew.filter(
        (s) => s.user == user.pterodactylId
      );

      if (
        (JSON.stringify(serversInNewList) ==
          JSON.stringify(serversInOldList)) ==
        false
      ) {
        io.to(user.code).emit("pterodactylServersUpdate", serversInNewList);
      }
    }
  }

  //console.log(users);
}

//QEMU
app.get("/qemu/myservers", async (req, res) => {
  var servers = [];

  for (var server of qemuServersCache) {
    var serverCopy = {};
    Object.assign(serverCopy, server);

    if (server.user == res.locals.user.code) {
      delete serverCopy.user;

      servers.push(serverCopy);
    }
  }
  res.json(servers);
});

app.get("/qemu/myservers/:serverCode/activity", async (req, res) => {
  var activityCollection = mongo().collection("qemuActivity");

  var activity = await activityCollection
    .find({
      server: req.params.serverCode,
    })
    .toArray();

  activity.reverse();

  var activityItems = [];
  var i = 0;

  for (var act of activity) {
    if (i < 26) {
      delete act._id;
      delete act.code;

      activityItems.push(act);
    }
    i++;
  }

  res.json(activity);
});

app.get("/qemu/myservers/:serverCode/delete", async (req, res) => {
  const serversCollection = mongo().collection("qemuServers");
  var target = await serversCollection.findOne({
    code: req.params.serverCode || "",
  });
  if (!target) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The target server could not be found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });
    return;
  }

  var date = new Date();
  date.setSeconds(0);
  date =
    date.getUTCFullYear() +
    "-" +
    ("00" + (date.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date.getUTCDate()).slice(-2) +
    " " +
    ("00" + date.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date.getUTCSeconds()).slice(-2);

  await serversCollection.updateOne(
    { code: target.code },
    {
      $set: {
        renewal: false,
        renewDate: date,
      },
    }
  );

  var activityCollection = mongo().collection("qemuActivity");
  await activityCollection.insertOne({
    code: uuidv4(),
    timestamp: returnUtcTimestamp(),
    user: res.locals.user.code,
    server: target.code,
    event: "server.delete",
    status: 1,
    snapshots: {
      server: target,
      user: res.locals.user,
    },
  });

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "Your server will be deleted.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.get("/qemu/myservers/:serverCode/cancel", async (req, res) => {
  const serversCollection = mongo().collection("qemuServers");
  var target = await serversCollection.findOne({
    code: req.params.serverCode || "",
  });
  if (!target) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The target server could not be found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });
    return;
  }

  await serversCollection.updateOne(
    { code: target.code },
    {
      $set: {
        renewal: false,
      },
    }
  );

  var activityCollection = mongo().collection("qemuActivity");
  await activityCollection.insertOne({
    code: uuidv4(),
    timestamp: returnUtcTimestamp(),
    user: res.locals.user.code,
    server: target.code,
    event: "server.cancel",
    status: 1,
    snapshots: {
      server: target,
      user: res.locals.user,
    },
  });

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "The subscription has been removed.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.post("/qemu/myservers/:serverCode", async (req, res) => {
  var servers = [];

  for (var server of qemuServersCache) {
    var serverCopy = {};
    Object.assign(serverCopy, server);

    if (server.user == res.locals.user.code) {
      delete serverCopy.user;

      servers.push(serverCopy);
    }
  }

  if (req.body.serverIso) {
    const allocationsCollection = mongo().collection("qemuAllocations");
    const serversCollection = mongo().collection("qemuServers");
    var target = servers.find((s) => s.code == req.params.serverCode);

    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Server ISO",
            body: "The target server could not be found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    target = await serversCollection.findOne({ code: target.code });
    var allocation = await allocationsCollection.findOne({
      code: target.allocationId,
    });
    var allocationNodeSocket = qemuSockets.find((s) => s.id == allocation.node);

    if (allocationNodeSocket) {
      allocationNodeSocket.socket.emit(
        "isoMount",
        {
          server: target.qemuCode,
          iso: req.body.serverIso,
        },
        async () => {
          var activityCollection = mongo().collection("qemuActivity");
          await activityCollection.insertOne({
            code: uuidv4(),
            timestamp: returnUtcTimestamp(),
            user: res.locals.user.code,
            server: target.code,
            event: "server.mountiso",
            status: 1,
            snapshots: {
              iso: req.body.serverIso,
              server: target,
              user: res.locals.user,
            },
          });

          res.json({
            success: false,
            msg: [
              {
                title: "Server ISO",
                body: "The ISO has been mounted.",
                displayTime: 3,
                status: 1,
              },
            ],
          });
        }
      );

      //console.log(req.body);
    } else {
      var activityCollection = mongo().collection("qemuActivity");
      await activityCollection.insertOne({
        code: uuidv4(),
        timestamp: returnUtcTimestamp(),
        user: res.locals.user.code,
        server: target.code,
        event: "server.mountiso",
        status: 0,
        snapshots: {
          iso: req.body.serverIso,
          server: target,
          user: res.locals.user,
        },
      });

      res.json({
        success: false,
        msg: [
          {
            title: "Server ISO",
            body: "Couldn't connect to hypervisor.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }
  } else if (req.body.cloudinit) {
    const allocationsCollection = mongo().collection("qemuAllocations");
    const serversCollection = mongo().collection("qemuServers");
    var target = servers.find((s) => s.code == req.params.serverCode);
    var target2 = target;
    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Cloudinit",
            body: "The target server could not be found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    target = await serversCollection.findOne({ code: target.code });

    var allocation = await allocationsCollection.findOne({
      code: target.allocationId,
    });
    var allocationNodeSocket = qemuSockets.find((s) => s.id == allocation.node);

    if (allocationNodeSocket) {
      const image = req.body.cloudinit || "ubuntu_live_server_2104";

      var cloudinitPassword =
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8)) +
        String(Math.random().toString(36).slice(-8));

      var cloudinitConfig = {
        password: cloudinitPassword,
        hostname: target2.name.split(" ").join("-"),
        phone_home: `http://null:${serverPort}/qemu/completeinstall/${target2.code}`,
        base_image: image,
      };

      await serversCollection.updateOne(
        {
          code: target2.code,
        },
        {
          $set: {
            cloudinit: cloudinitConfig,
            status: {
              installed: false,
              installProgress: 0,
            },
          },
        }
      );

      var activityCollection = mongo().collection("qemuActivity");
      await activityCollection.insertOne({
        code: uuidv4(),
        timestamp: returnUtcTimestamp(),
        user: res.locals.user.code,
        server: target.code,
        event: "server.cloudinit",
        status: 1,
        snapshots: {
          base_image: image,
          cloudinit_config: cloudinitConfig,
          server: target,
          user: res.locals.user,
        },
      });

      res.json({
        success: false,
        msg: [
          {
            title: "Cloudinit",
            body: "The cloudinit installer has started.",
            displayTime: 3,
            status: 1,
          },
        ],
      });

      allocationNodeSocket.socket.emit("runCloudinitInstaller", {
        cloudinitConfig,
        server: target.qemuCode,
      });
    } else {
      var activityCollection = mongo().collection("qemuActivity");
      await activityCollection.insertOne({
        code: uuidv4(),
        timestamp: returnUtcTimestamp(),
        user: res.locals.user.code,
        server: target.code,
        event: "server.cloudinit",
        status: 0,
        snapshots: {
          base_image: image,
          cloudinit_config: cloudinitConfig,
          server: target,
          user: res.locals.user,
        },
      });

      res.json({
        success: false,
        msg: [
          {
            title: "Cloudinit",
            body: "Couldn't connect to hypervisor.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }
  } else if (req.body.deleteFirewallRule) {
    const allocationsCollection = mongo().collection("qemuAllocations");
    const serversCollection = mongo().collection("qemuServers");
    var target = servers.find((s) => s.code == req.params.serverCode);
    var target2 = target;
    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Firewall",
            body: "The target server could not be found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    target = await serversCollection.findOne({ code: target.code });

    var allocation = await allocationsCollection.findOne({
      code: target.allocationId,
    });
    var allocationNodeSocket = qemuSockets.find((s) => s.id == allocation.node);

    if (allocationNodeSocket) {
      const ruleId = parseInt(req.body.deleteFirewallRule.ruleId);
      const rule = target2.firewall_rules.find((r) => r.rule_id == ruleId);

      allocationNodeSocket.socket.emit(
        "deleteFirewallRule",
        {
          public_port: rule.public_port,
        },
        async function () {
          var activityCollection = mongo().collection("qemuActivity");
          await activityCollection.insertOne({
            code: uuidv4(),
            timestamp: returnUtcTimestamp(),
            user: res.locals.user.code,
            server: target.code,
            event: "server.firewall.deleterule",
            status: 1,
            snapshots: {
              firewall_rule: rule,
              server: target,
              user: res.locals.user,
            },
          });

          res.json({
            success: true,
            msg: [
              {
                title: "Firewall",
                body: "The rule has been deleted.",
                displayTime: 3,
                status: 1,
              },
            ],
          });
        }
      );
    } else {
      var activityCollection = mongo().collection("qemuActivity");
      await activityCollection.insertOne({
        code: uuidv4(),
        timestamp: returnUtcTimestamp(),
        user: res.locals.user.code,
        server: dbConfig.code,
        event: "server.firewall.deleterule",
        status: 0,
        snapshots: {
          firewall_rule: rule,
          server: target,
          user: res.locals.user,
        },
      });

      res.json({
        success: false,
        msg: [
          {
            title: "Firewall",
            body: "Couldn't connect to hypervisor.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }
  } else if (req.body.newFirewallRule) {
    const allocationsCollection = mongo().collection("qemuAllocations");
    const serversCollection = mongo().collection("qemuServers");
    var target = servers.find((s) => s.code == req.params.serverCode);

    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Firewall",
            body: "The target server could not be found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    target = await serversCollection.findOne({ code: target.code });

    var allocation = await allocationsCollection.findOne({
      code: target.allocationId,
    });
    var allocationNodeSocket = qemuSockets.find((s) => s.id == allocation.node);

    if (allocationNodeSocket) {
      const port = parseInt(req.body.newFirewallRule.port);
      const type = req.body.newFirewallRule.type;
      if (
        port > 65535 ||
        port < 1 ||
        (type != "tcp" && type != "udp" && type != "tcpudp")
      ) {
        var activityCollection = mongo().collection("qemuActivity");
        await activityCollection.insertOne({
          code: uuidv4(),
          timestamp: returnUtcTimestamp(),
          user: res.locals.user.code,
          server: target.code,
          event: "server.firewall.createrule",
          status: 0,
          snapshots: {
            firewall_rule: {
              allocationNetwork: allocation.address,
              port: port,
              type: type,
            },
            server: target,
            user: res.locals.user,
          },
        });

        res.json({
          success: false,
          msg: [
            {
              title: "Firewall",
              body: "Invalid rule.",
              displayTime: 3,
              status: 0,
            },
          ],
        });
        return;
      }

      allocationNodeSocket.socket.emit(
        "newFirewallRule",
        {
          server: target.qemuCode,
          allocationNetwork: allocation.address,
          port: port,
          type: type,
        },
        async function () {
          var activityCollection = mongo().collection("qemuActivity");
          await activityCollection.insertOne({
            code: uuidv4(),
            timestamp: returnUtcTimestamp(),
            user: res.locals.user.code,
            server: target.code,
            event: "server.firewall.createrule",
            status: 1,
            snapshots: {
              firewall_rule: {
                allocationNetwork: allocation.address,
                port: port,
                type: type,
              },
              server: target,
              user: res.locals.user,
            },
          });

          res.json({
            success: false,
            msg: [
              {
                title: "Firewall",

                body: "New rule created.",
                displayTime: 3,
                status: 1,
              },
            ],
          });
        }
      );
    } else {
      var activityCollection = mongo().collection("qemuActivity");
      await activityCollection.insertOne({
        code: uuidv4(),
        timestamp: returnUtcTimestamp(),
        user: res.locals.user.code,
        server: target.code,
        event: "server.firewall.createrule",
        status: 0,
        snapshots: {
          firewall_rule: {
            allocationNetwork: allocation.address,
            port: port,
            type: type,
          },
          server: target,
          user: res.locals.user,
        },
      });

      res.json({
        success: false,
        msg: [
          {
            title: "Firewall",
            body: "Couldn't connect to hypervisor.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }
  } else if (req.body.power) {
    const allocationsCollection = mongo().collection("qemuAllocations");
    const serversCollection = mongo().collection("qemuServers");
    var target = servers.find((s) => s.code == req.params.serverCode);

    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Server power",
            body: "The target server could not be found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    target = await serversCollection.findOne({ code: target.code });
    var allocation = await allocationsCollection.findOne({
      code: target.allocationId,
    });
    var allocationNodeSocket = qemuSockets.find((s) => s.id == allocation.node);

    if (allocationNodeSocket) {
      if (req.body.power == "kill") {
        var activityCollection = mongo().collection("qemuActivity");
        await activityCollection.insertOne({
          code: uuidv4(),
          timestamp: returnUtcTimestamp(),
          user: res.locals.user.code,
          server: target.code,
          event: "server.power.kill",
          status: 1,
          snapshots: {
            server: target,
            user: res.locals.user,
          },
        });

        allocationNodeSocket.socket.emit("killServer", target.qemuCode);
      }

      if (req.body.power == "start") {
        var activityCollection = mongo().collection("qemuActivity");
        await activityCollection.insertOne({
          code: uuidv4(),
          timestamp: returnUtcTimestamp(),
          user: res.locals.user.code,
          server: target.code,
          event: "server.power.start",
          status: 1,
          snapshots: {
            server: target,
            user: res.locals.user,
          },
        });

        allocationNodeSocket.socket.emit("startServer", target.qemuCode);
      }

      if (req.body.power == "reset") {
        var activityCollection = mongo().collection("qemuActivity");
        await activityCollection.insertOne({
          code: uuidv4(),
          user: res.locals.user.code,
          server: target.code,
          event: "server.power.reset",
          status: 1,
          snapshots: {
            server: target,
            user: res.locals.user,
          },
        });

        allocationNodeSocket.socket.emit("resetServer", target.qemuCode);
      }

      //console.log(req.body);

      res.json({
        success: false,
        msg: [
          {
            title: "Server power",
            body: "The power command has been sent.",
            displayTime: 3,
            status: 1,
          },
        ],
      });
    } else {
      res.json({
        success: false,
        msg: [
          {
            title: "Server power",
            body: "Couldn't connect to hypervisor.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }
  } else if (req.body.name) {
    var target = servers.find((s) => s.code == req.params.serverCode);
    const serversCollection = mongo().collection("qemuServers");

    if (!target) {
      res.json({
        success: false,
        msg: [
          {
            title: "Server rename",
            body: "The selected server was not found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    await serversCollection.updateOne(
      {
        code: target.code,
      },
      {
        $set: {
          name: req.body.name,
        },
      }
    );

    var activityCollection = mongo().collection("qemuActivity");
    await activityCollection.insertOne({
      code: uuidv4(),
      timestamp: returnUtcTimestamp(),
      user: res.locals.user.code,
      server: target.code,
      event: "server.rename",
      status: 1,
      snapshots: {
        new_name: req.body.name,
        server: target,
        user: res.locals.user,
      },
    });

    res.json({
      success: true,
      msg: [
        {
          title: "Server rename",
          body: "The server name has been changed.",
          displayTime: 3,
          status: 1,
        },
      ],
    });

    return;

    //work
  } else {
    res.json({
      success: false,
      msg: [
        {
          title: "Unkown error",
          body: "Could not handle request.",
          displayTime: 3,
          status: 0,
        },
      ],
    });
    return;
  }
});

function returnUtcTimestamp() {
  var date = new Date();
  date.setSeconds(0);
  date =
    date.getUTCFullYear() +
    "-" +
    ("00" + (date.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date.getUTCDate()).slice(-2) +
    " " +
    ("00" + date.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date.getUTCSeconds()).slice(-2);

  return date;
}

//ADMIN

app.get("/admin/users", async (req, res) => {
  const userCollection = mongo().collection("users");
  const users = await userCollection.find({}).toArray();
  const userList = [];

  for (var user of users) {
    var userObject = user;
    userObject.servers = [];

    var ownedPterodactylServers = pterodactylServerCache.filter(
      (s) => s.user == user.pterodactylId
    );

    const invoicesCollection = mongo().collection("invoices");

    var userInvoiceItems = await invoicesCollection
      .find({ user: user.code })
      .toArray();

    userObject.invoices = userInvoiceItems.slice(-6);

    for (var server of ownedPterodactylServers) {
      userObject.servers.push(server.uuid);
    }

    userList.push(userObject);
  }

  res.json(userList);
});

app.get("/admin/pterodactyl/servers/:serverCode/delete", async (req, res) => {
  const ownedServer = pterodactylServerCache.find(
    (s) => s.uuid == req.params.serverCode
  );

  if (!ownedServer) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The selected server was not found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });

    return;
  }

  const serversCollection = mongo().collection("pterodactylServers");

  var date2 = new Date();
  date2 =
    date2.getUTCFullYear() +
    "-" +
    ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date2.getUTCDate()).slice(-2) +
    " " +
    ("00" + date2.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date2.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date2.getUTCSeconds()).slice(-2);

  await serversCollection.updateOne(
    { code: req.params.serverCode },
    {
      $set: {
        renew: false,
        renewDate: date2,
      },
    }
  );

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "Your server will be deleted.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.get("/admin/pterodactyl/servers/:serverCode/cancel", async (req, res) => {
  const ownedServer = pterodactylServerCache.find(
    (s) => s.uuid == req.params.serverCode
  );

  if (!ownedServer) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The selected server was not found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });

    return;
  }

  const serversCollection = mongo().collection("pterodactylServers");

  var date2 = new Date();
  date2 =
    date2.getUTCFullYear() +
    "-" +
    ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date2.getUTCDate()).slice(-2) +
    " " +
    ("00" + date2.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date2.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date2.getUTCSeconds()).slice(-2);

  await serversCollection.updateOne(
    { code: req.params.serverCode },
    {
      $set: {
        renew: false,
        lastChanged: date2,
      },
    }
  );

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "The subscription has been removed.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.get(
  "/admin/pterodactyl/servers/:serverCode/reinstall",
  async (req, res) => {
    const ownedServer = pterodactylServerCache.find(
      (s) => s.uuid == req.params.serverCode
    );

    if (!ownedServer) {
      res.json({
        success: false,
        msg: [
          {
            title: "Server reinstall",
            body: "The selected server was not found.",
            displayTime: 3,
            status: 0,
          },
        ],
      });

      return;
    }

    var allServers = await pterodactyl.getServers();

    const server = allServers.find(
      (s) => s.attributes.external_id == ownedServer.uuid
    );

    await pterodactyl.post(
      `application/servers/${server.attributes.id}/reinstall`
    );

    res.json({
      success: true,
      msg: [
        {
          title: "Server reinstall",
          body: "The installation process has started.",
          displayTime: 3,
          status: 1,
        },
      ],
    });
  }
);

app.get("/admin/pterodactyl/servers", async (req, res) => {
  const ptServers = pterodactylServerCache;
  const userCollection = mongo().collection("users");
  const users = await userCollection.find({}).toArray();

  var servers = [];
  for (var server of ptServers) {
    const serverUser = users.find((u) => u.pterodactylId == server.user);
    if (serverUser) {
      server.user = serverUser;
      delete server.user._id;
    }

    servers.push(server);
  }

  res.json(servers);
});

//CLIENT
app.get("/pterodactyl/myservers/:serverCode/delete", async (req, res) => {
  const ownedServer = pterodactylServerCache.find(
    (s) =>
      s.user == res.locals.user.pterodactylId && s.uuid == req.params.serverCode
  );

  if (!ownedServer) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The selected server was not found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });

    return;
  }

  const serversCollection = mongo().collection("pterodactylServers");

  var date2 = new Date();
  date2 =
    date2.getUTCFullYear() +
    "-" +
    ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date2.getUTCDate()).slice(-2) +
    " " +
    ("00" + date2.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date2.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date2.getUTCSeconds()).slice(-2);

  await serversCollection.updateOne(
    { code: req.params.serverCode },
    {
      $set: {
        renew: false,
        renewDate: date2,
      },
    }
  );

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "Your server will be deleted.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.get("/pterodactyl/myservers/:serverCode/cancel", async (req, res) => {
  const ownedServer = pterodactylServerCache.find(
    (s) =>
      s.user == res.locals.user.pterodactylId && s.uuid == req.params.serverCode
  );

  if (!ownedServer) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server cancelation",
          body: "The selected server was not found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });

    return;
  }

  const serversCollection = mongo().collection("pterodactylServers");

  var date2 = new Date();
  date2 =
    date2.getUTCFullYear() +
    "-" +
    ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
    "-" +
    ("00" + date2.getUTCDate()).slice(-2) +
    " " +
    ("00" + date2.getUTCHours()).slice(-2) +
    ":" +
    ("00" + date2.getUTCMinutes()).slice(-2) +
    ":" +
    ("00" + date2.getUTCSeconds()).slice(-2);

  await serversCollection.updateOne(
    { code: req.params.serverCode },
    {
      $set: {
        renew: false,
        lastChanged: date2,
      },
    }
  );

  res.json({
    success: true,
    msg: [
      {
        title: "Server cancelation",
        body: "The subscription has been removed.",
        displayTime: 2,
        status: 1,
      },
    ],
  });
});

app.get("/pterodactyl/myservers/:serverCode/reinstall", async (req, res) => {
  const ownedServer = pterodactylServerCache.find(
    (s) =>
      s.user == res.locals.user.pterodactylId && s.uuid == req.params.serverCode
  );

  if (!ownedServer) {
    res.json({
      success: false,
      msg: [
        {
          title: "Server reinstall",
          body: "The selected server was not found.",
          displayTime: 3,
          status: 0,
        },
      ],
    });

    return;
  }

  var allServers = await pterodactyl.getServers();

  const server = allServers.find(
    (s) => s.attributes.external_id == ownedServer.uuid
  );

  await pterodactyl.post(
    `application/servers/${server.attributes.id}/reinstall`
  );

  res.json({
    success: true,
    msg: [
      {
        title: "Server reinstall",
        body: "The installation process has started.",
        displayTime: 3,
        status: 1,
      },
    ],
  });
});

app.get("/pterodactyl/myservers", async (req, res) => {
  const ownedServers = pterodactylServerCache.filter(
    (s) => s.user == res.locals.user.pterodactylId
  );

  res.json(ownedServers);
});

app.get("/order", async (req, res) => {
  const pterodactylPackagesCollection = mongo().collection(
    "pterodactylPackages"
  );
  const serversCollection = mongo().collection("pterodactylServers");
  const allServers = await serversCollection.find({}).toArray();
  const allPterodactlPackages = await pterodactylPackagesCollection
    .find({})
    .toArray();
  const userOwnedServers = allServers.filter(
    (s) => s.user == res.locals.user.pterodactylId && s.packageConfig != null
  );

  var pterodactylPackages = [];

  for (var ptPackage of allPterodactlPackages) {
    var object = {
      code: ptPackage.code,
      name: ptPackage.options.name,
      regions: ptPackage.locations,
      specs: {
        cpu: ptPackage.specs.cpu / 100,
        disk:
          ptPackage.specs.disk > 1023
            ? `${ptPackage.specs.disk / 1024} GB`
            : `${ptPackage.specs.disk} MB`,
        ram:
          ptPackage.specs.ram > 1023
            ? `${ptPackage.specs.ram / 1024} GB`
            : `${ptPackage.specs.ram} MB`,
      },
      categories: ptPackage.options.categories,
      price: ptPackage.price,
      limitReached: false,
    };

    pterodactylPackages.push(object);
  }

  res.json({
    pterodactylPackages: pterodactylPackages,
  });
});

app.post("/qemu/completeinstall/:serverCode", async (req, res) => {
  const serversCollection = mongo().collection("qemuServers");
  const serverCode = req.params.serverCode;

  await serversCollection.updateOne(
    { code: serverCode },
    {
      $set: {
        status: {
          installed: true,
          installProgress: 100,
        },
      },
    }
  );

  res.json("OK, WELCOME TO THE DISKCRAFT NETWORK");
});

app.post("/order", async (req, res) => {
  var isDedicated = false;
  var config;
  var isNewUser = false;

  var appConfig = req.body;

  if (appConfig.appType == "qemu") {
    const serversCollection = mongo().collection("qemuServers");
    const allocationsCollection = mongo().collection("qemuAllocations");
    const packagesCollection = mongo().collection("qemuPackages");

    const package = await packagesCollection.findOne({
      code: appConfig.appPackage,
    });

    if (!package) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "The selected server type could not be found.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    if (appConfig.appQuantity > 5) appConfig.appQuantity = 5;

    if (res.locals.user.balance - appConfig.appQuantity * package.price < 0) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "You don't have enough balance to complete this order.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    var enoughAllocations = true;
    for (let i = 0; i < appConfig.appQuantity; i++) {
      await new Promise(async (reslv) => {
        const freeAllocations = await allocationsCollection
          .find({
            assigned: false,
            unlocked: true,
          })
          .toArray();

        var tries = 0;
        var targetAllocation = null;
        var allocationNodeIp = "";
        var allocationNodeSocket = "";

        while (targetAllocation == null && tries < 11) {
          if (freeAllocations[tries] == null) {
            tries = 11;
          } else {
            var allocation = freeAllocations[tries];
            var allocationNodeSocket = qemuSockets.find(
              (s) => s.id == allocation.node
            );

            if (allocationNodeSocket) {
              await new Promise((res) => {
                var timeout;
                allocationNodeSocket.socket.emit(
                  "statusCheck",
                  {},
                  function (response) {
                    allocationNodeIp = response.nodeIp;
                    targetAllocation = allocation;
                    allocationNodeSocket = allocationNodeSocket.socket;

                    clearTimeout(timeout);
                    res();
                  }
                );

                timeout = setTimeout(() => {
                  res();
                }, 500);
              });
            }
          }
          tries++;
        }

        if (!targetAllocation) {
          enoughAllocations = false;
          reslv();
        } else {
          await allocationsCollection.updateOne(
            {
              code: targetAllocation.code,
            },
            {
              $set: {
                assigned: true,
              },
            }
          );

          var severUuid = uuidv4();

          const serverName = appConfig.appNames[i] || `Server ${i + 1}`;

          var vncPassword =
            String(Math.random().toString(36).slice(-8)) +
            String(Math.random().toString(36).slice(-8)) +
            String(Math.random().toString(36).slice(-8));

          var cloudinitPassword =
            String(Math.random().toString(36).slice(-8)) +
            String(Math.random().toString(36).slice(-8)) +
            String(Math.random().toString(36).slice(-8)) +
            String(Math.random().toString(36).slice(-8));

          var qemuConfig = {
            name: serverName,
            config_prefix: severUuid,
            cloudinit: {
              password: cloudinitPassword,
              hostname: serverName.split(" ").join("-"),
              phone_home: `http://5.161.51.188:${serverPort}/qemu/completeinstall/${severUuid}`,
              base_image: `ubuntu_live_server_2104`,
            },
            network: {
              mac: randomMac("52:54:00"),
              allocation: {
                network: targetAllocation.network,
                dhcp: targetAllocation.dhcp,
              },
              speed: package.network_speed,
            },
            vnc: {
              port: targetAllocation.vnc_port,
              password: vncPassword,
            },
            novnc_port: targetAllocation.novnc_port,
            specs: {
              cpu: package.specs.cpu,
              memory: package.specs.ram,
              disk: package.specs.disk,
            },
          };

          var date = new Date();
          date.setSeconds(0);
          date =
            date.getUTCFullYear() +
            "-" +
            ("00" + (date.getUTCMonth() + 1)).slice(-2) +
            "-" +
            ("00" + date.getUTCDate()).slice(-2) +
            " " +
            ("00" + date.getUTCHours()).slice(-2) +
            ":" +
            ("00" + date.getUTCMinutes()).slice(-2) +
            ":" +
            ("00" + date.getUTCSeconds()).slice(-2);

          var priceIndex = 1;

          if (appConfig.appBillingInterval == "3") priceIndex = 0.975;
          if (appConfig.appBillingInterval == "6") priceIndex = 0.96;
          if (appConfig.appBillingInterval == "12") priceIndex = 0.95;

          var dbConfig = {
            code: severUuid,
            name: serverName,
            qemuCode: severUuid,
            renewDate: date,
            renewal: true,
            suspended: false,
            billingInterval: appConfig.appBillingInterval,
            priceIndex,
            status: {
              installed: false,
              installProgress: 0,
            },
            cloudinit: qemuConfig.cloudinit,
            package,
            novnc: {
              port: qemuConfig.novnc_port,
              password: qemuConfig.vnc.password,
              host: targetAllocation.novnc_host,
            },
            specs: package.specs,
            allocationId: targetAllocation.code,
            user: res.locals.user.code,
            price: package.price,
          };

          await serversCollection.insertOne(dbConfig);

          allocationNodeSocket.emit(
            "createQemuServer",
            qemuConfig,
            function (response) {}
          );

          var activityCollection = mongo().collection("qemuActivity");

          await activityCollection.insertOne({
            code: uuidv4(),
            timestamp: returnUtcTimestamp(),
            user: res.locals.user.code,
            server: dbConfig.code,
            event: "server.create",
            status: 1,
            snapshots: {
              server: dbConfig,
              user: res.locals.user,
            },
          });

          setTimeout(() => {
            reslv();
          }, 1000);
        }
      });
    }

    if (enoughAllocations == true) {
      res.json({
        success: true,
        msg: [
          {
            title: "Order",
            body: "Your order had been completed, we will now create & install your servers.",
            status: 1,
            displayTime: 3,
          },
        ],
      });
    } else {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "Not enough free allocations were found, not all your servers were created.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }
  }

  if (appConfig.appType == "pterodactyl") {
    const serversCollection = mongo().collection("pterodactylServers");
    const usersCollection = mongo().collection("users");
    const packagesCollection = mongo().collection("pterodactylPackages");

    if (res.locals.user.pterodactylId == null) {
      const allPtUsers = await pterodactyl.getUsers();
      const possibleExistingUser = allPtUsers.find(
        (u) => u.attributes.external_id == res.locals.user.code
      );

      if (possibleExistingUser) {
        await usersCollection.updateOne(
          { code: res.locals.user.code },
          {
            $set: {
              pterodactylId: possibleExistingUser.attributes.id,
            },
          }
        );

        res.locals.user.pterodactylId = possibleExistingUser.attributes.id;
      } else {
        //CREATE USER

        const userRequest = await pterodactyl.createUser({
          external_id: res.locals.user.code,
          email: res.locals.user.email,
          username: res.locals.user.username,
          first_name: res.locals.user.firstName,
          last_name: res.locals.user.lastName,
        });

        if (userRequest?.data?.attributes?.id) {
          await usersCollection.updateOne(
            { code: res.locals.user.code },
            {
              $set: {
                pterodactylId: userRequest.data.attributes.id,
              },
            }
          );

          res.locals.user.pterodactylId = userRequest.data.attributes.id;

          io.to(res.locals.user.code).emit("notifications", [
            {
              title: "Pterodactyl",
              body: "Your Pterodactyl account has been created, please check your email to complete the account setup process.",
              status: 0,
              displayTime: 5,
            },
          ]);

          isNewUser = true;
        } else {
          res.json({
            success: false,
            msg: [
              {
                title: "Order",
                body: "Something went wrong while creating your Pterodactyl account, please contact support to resolve this issue.",
                status: 0,
                displayTime: 3,
              },
            ],
          });
          return;
        }
      }
    }

    var pterodactylLocationId = 1;
    console.log (appConfig)
    const package = await packagesCollection.findOne({
      code: appConfig.appPackage,
    });
    console.log (package)
    var packagePrice = package.price;
    var extraCosts = 0;

    var useNVMe = appConfig?.useNVMe || false;
    if (package?.useNVMe == true) useNVMe = true;
    if (
      useNVMe == true &&
      package?.useNVMe != true &&
      package.isDedicatedCpu == false
    ) {
      packagePrice = packagePrice + 2;
      extraCosts = extraCosts + 2;
    }

    if (!package) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "The selected server type could not be found.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    const ownedServers = pterodactylServerCache.filter(
      (s) => s.user == res.locals.user.pterodactylId
    );

    const serversWithSamePackage = ownedServers.filter(
      (s) => s.package == package.code
    );

    const deployAfterLimitReach =
      package?.options?.canOrderAfterLimitReached || false;
    const itemPriceAfterLimitReached =
      package?.options?.priceAfterLimitReached || package.price;
    const spotsLeft =
      (package?.options?.userLimit || -1) - serversWithSamePackage.length;

    if ((package?.options?.userLimit || -1) > -1) {
      if (spotsLeft <= 0 && deployAfterLimitReach == false) {
        res.json({
          success: false,
          msg: [
            {
              title: "Order",
              body: `You have reached the limit for this item (${package.options.userLimit}).`,
              status: 0,
              displayTime: 3,
            },
          ],
        });
        return;
      }

      if (spotsLeft < appConfig.appQuantity && deployAfterLimitReach == false) {
        io.to(res.locals.user.code).emit("notifications", [
          {
            title: "Order",
            body: "Not all your servers were created due to a package quantity limit.",
            status: 0,
            displayTime: 5,
          },
        ]);

        appConfig.appQuantity = spotsLeft;
      }
    }
    var totalPrice = 0;

    for (let i = 0; i < appConfig.appQuantity; i++) {
      var thisPackagePrice = packagePrice;

      if (i + 1 > spotsLeft && (package?.options?.userLimit || -1) > -1) {
        thisPackagePrice = itemPriceAfterLimitReached + extraCosts;
      }

      totalPrice += thisPackagePrice;
    }

    if (package.isDedicatedCpu == false) {
      pterodactylLocationId = locations.find(
        (l) => l.code == appConfig.appLocation
      );
      pterodactylLocationId = pterodactylLocationId.id;
    } else {
      if (appConfig.appLocation == "us1") pterodactylLocationId = 8;
    }

    var leftoverBalance =
      res.locals.user.balance - appConfig.appQuantity * packagePrice;

    if (res.locals.user.balance - totalPrice < 0) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "You don't have enough balance to complete this order.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    if (appConfig.appQuantity > 9) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "Server limit exceeded.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    if (package.locations.includes(appConfig.appLocation) == false) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "The server type is not available in the selected location.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    var allAllocations = await pterodactyl.getAllocations();
    var allNodes = await pterodactyl.getNodes();

    const locationNodes = allNodes.filter(
      (n) => n.attributes.location_id == pterodactylLocationId
    );

    var availableAllocations = [];

    const requiredAllocations = package?.allocationCount || 1;

    if (package.isDedicatedCpu == false) {
      for (var node of locationNodes) {
        const nodeId = node.attributes.id;
        const nodeAllocations = allAllocations.filter(
          (a) => a.node == nodeId && a.attributes.assigned == false
        );
        const memavailable =
          node.attributes.allocated_resources.memory +
            package.specs.ram * appConfig.appQuantity <
          node.attributes.memory *
            (1 + node.attributes.memory_overallocate / 100);

        const diskavailable =
          node.attributes.allocated_resources.disk +
            package.specs.disk * appConfig.appQuantity <
          node.attributes.disk * (1 + node.attributes.disk_overallocate / 100);

        if (
          diskavailable == true &&
          memavailable == true &&
          (requiredAllocations == 1 ||
            (requiredAllocations > 1 &&
              nodeAllocations.length >= requiredAllocations))
        ) {
          availableAllocations = [...availableAllocations, ...nodeAllocations];
        }
      }
    }

    var packageStor = [];
    console.log(appConfig)
    var container = package.container.find(
      (c) => c.runtime == appConfig.appRuntime
    );

    if (!container) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "The selected server runtime could not be found.",
            status: 0,
            displayTime: 3,
          },
        ],
      });
      return;
    }

    if (
      availableAllocations.length <
        appConfig.appQuantity * requiredAllocations &&
      package.isDedicatedCpu == false
    ) {
      res.json({
        success: false,
        msg: [
          {
            title: "Order",
            body: "Not enough space was found on any of our servers, please try again later or choose a smaller server type.",
            status: 0,
            displayTime: 5,
          },
        ],
      });
      return;
    }

    var containerDedicatedPort = container.allocationPort;
    delete container.runtime;

    for (let i = 0; i < appConfig.appQuantity; i++) {
      const serverCode = uuidv4();
      const serverName = appConfig.appNames[i] || `Server ${i + 1}`;

      var thisPackagePrice = packagePrice;

      if (i + 1 > spotsLeft && (package?.options?.userLimit || -1) > -1) {
        thisPackagePrice = itemPriceAfterLimitReached + extraCosts;
      }

      var pterodactylCreateObject = {
        ...container,
        name: serverName,
        user: res.locals.user.pterodactylId,
        external_id: serverCode,
        limits: {
          cpu: package.specs.cpu,
          disk: package.specs.disk,
          memory: package.specs.ram,
          io: 500,
          swap: 0,
        },
        start_on_completion: true,
      };

      var date = new Date();
      date.setSeconds(0);
      date =
        date.getUTCFullYear() +
        "-" +
        ("00" + (date.getUTCMonth() + 1)).slice(-2) +
        "-" +
        ("00" + date.getUTCDate()).slice(-2) +
        " " +
        ("00" + date.getUTCHours()).slice(-2) +
        ":" +
        ("00" + date.getUTCMinutes()).slice(-2) +
        ":" +
        ("00" + date.getUTCSeconds()).slice(-2);

      var date2 = new Date();
      date2 =
        date2.getUTCFullYear() +
        "-" +
        ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
        "-" +
        ("00" + date2.getUTCDate()).slice(-2) +
        " " +
        ("00" + date2.getUTCHours()).slice(-2) +
        ":" +
        ("00" + date2.getUTCMinutes()).slice(-2) +
        ":" +
        ("00" + date2.getUTCSeconds()).slice(-2);

      var priceIndex = 1;

      if (appConfig.appBillingInterval == "3") priceIndex = 0.975;
      if (appConfig.appBillingInterval == "6") priceIndex = 0.96;
      if (appConfig.appBillingInterval == "12") priceIndex = 0.95;

      await serversCollection.insertOne({
        code: serverCode,
        price: thisPackagePrice,
        renew: true,
        packageConfig: package,
        renewDate: date,
        orderDate: date2,
        lastChanged: date2,
        billingInterval: appConfig.appBillingInterval,
        priceIndex,
        showPlaceholderData: true,
        nvmeDisk: useNVMe,
        placeholderData: {
          specs: {
            cpu: package.specs.cpu / 100,
            disk: package.specs.disk / 1024,
            ram: package.specs.ram / 1024,
          },
          installProgress: 5,
          displayName: serverName,
        },
        user: res.locals.user.pterodactylId,
        locationId: pterodactylLocationId,
      });

      delete pterodactylCreateObject.allocationPort;

      packageStor.push({
        pterodactylObject: pterodactylCreateObject,
        serverCode,
        serverName,
        containerDedicatedPort,
      });
    }

    res.json({
      success: true,
      msg: [
        {
          title: "Order",
          body: "Your order has been completed, we will now create the servers for you.",

          status: 1,
          displayTime: 3,
        },
      ],
    });

    var i = 0;
    var awaitThesePromisesAfterCompletion = [];
    for (var serverTemplate of packageStor) {
      if (package.isDedicatedCpu == true) {
        isDedicated = true;

        var datacenterLocation = "";

        if (appConfig.appLocation == "de1") datacenterLocation = "fsn1";
        if (appConfig.appLocation == "de2") datacenterLocation = "nbg1";
        if (appConfig.appLocation == "fi1") datacenterLocation = "hel1";
        if (appConfig.appLocation == "us1") datacenterLocation = "ash";

        function make() {
          return new Promise(async (resolve) => {
            const allocationPort = container.allocationPort;
            const serverCodeExt = serverTemplate.pterodactylObject.external_id;
            const serverName = serverTemplate.pterodactylObject.name;
            const serverAlloc = serverTemplate.pterodactylObject.allocation;

            const { nodeId, host } = await privateServers.createServer(
              datacenterLocation,
              package.hetznerPackage,
              pterodactylLocationId,
              serversCollection,
              serverTemplate.serverCode
            );

            function createAllocation() {
              return new Promise(async (res) => {
                try {
                  const creationStatus = await pterodactyl.post(
                    `application/nodes/${nodeId}/allocations`,
                    {
                      ip: host,
                      ports: [allocationPort.toString()],
                    }
                  );
                  res();
                } catch (e) {
                  if (e.code == "ECONNABORTED") {
                    console.log("Retrying allocation creation");
                    await create();
                  } else {
                    console.log(e.response.data);
                  }

                  res();
                }
              });
            }

            await createAllocation();
            await sleep(5000);

            var allAllocations = await pterodactyl.getAllocations();
            var createdAllocation = allAllocations.find(
              (a) => a.attributes.ip == host
            );

            serverTemplate.pterodactylObject.allocation = {
              default: createdAllocation.attributes.id,
            };

            serverTemplate.pterodactylObject.external_id = serverCodeExt;
            serverTemplate.pterodactylObject.name = serverName;

            //console.log(serverTemplate.pterodactylObject);

            function create() {
              return new Promise(async (res) => {
                try {
                  const creationStatus = await pterodactyl.post(
                    "application/servers",
                    serverTemplate.pterodactylObject
                  );

                  res();
                } catch (e) {
                  // if (e.code == "ECONNABORTED") {
                  console.log("Retrying server creation");
                  // console.log(e.request);
                  // console.log(e.request.data);
                  // console.log(e);

                  await create();
                  // } else {

                  //   if (e.request.data) console.log(e.request.data);
                  // }

                  res();
                }
              });
            }

            await create();
            resolve();
          });
        }

        awaitThesePromisesAfterCompletion.push(make());
        await sleep(2000);
      } else {
        serverTemplate.pterodactylObject.allocation = {
          default: availableAllocations[i].attributes.id,
          additional: {},
        };

        if (requiredAllocations > 1) {
          for (let a = 0; a < requiredAllocations - 1; a++) {
            serverTemplate.pterodactylObject.allocation.additional[
              `alloc-${a}`
            ] = availableAllocations[i + a + 1].attributes.id;
          }
        }

        for (var key in serverTemplate.pterodactylObject.environment) {
          var value = serverTemplate.pterodactylObject.environment[key];

          if (value.startsWith("%_")) {
            //Must be a command

            value = value.replace("%_", "");

            if (value.startsWith("port_")) {
              //replace with a port
              value = value.replace("port_", "");

              var allocationId =
                serverTemplate.pterodactylObject.allocation.additional[
                  `alloc-${value}`
                ];

              var allocationPort = availableAllocations.find(
                (a) => a.attributes.id == allocationId
              );

              serverTemplate.pterodactylObject.environment[key] =
                allocationPort.attributes.port;
            }
          }
        }

        //

        function create() {
          return new Promise(async (res) => {
            try {
              const creationStatus = await pterodactyl.post(
                "application/servers",
                serverTemplate.pterodactylObject
              );

              if (useNVMe == true) {
                io.to("serverNode").emit("enableNVMe", {
                  uuid: creationStatus.data.attributes.uuid,
                });
                //reserved for future use
              }

              res();
            } catch (e) {
              if (e.code == "ECONNABORTED") {
                console.log("Retrying server creation");
                await create();
              } else {
                console.log(e.response.data.errors);
                if (e.data) console.log(e.data);
              }

              res();
            }
          });
        }

        await create();

        const serversCollection = mongo().collection("pterodactylServers");

        var currentServerStatus = await serversCollection.findOne({
          code: serverTemplate.serverCode,
        });

        currentServerStatus.placeholderData.installProgress = 100;

        await serversCollection.updateOne(
          { code: serverTemplate.serverCode },
          {
            $set: {
              placeholderData: currentServerStatus.placeholderData,
            },
          }
        );
        i = i + requiredAllocations - 1;
      }
      i++;
    }
    await Promise.all(awaitThesePromisesAfterCompletion);
  }
});

//privateServers.deleteServer("50343287-2e57-47c3-bf79-3fce333ba108");

//
//
//ACCOUNT GENERIC
app.post("/account/changeinfo", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  const diskosId = axios.create({
    baseURL: `https://id.yourdomain.com/`,
    timeout: 2500,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  diskosId
    .post("account/changeinfo", req.body)
    .then(async (resp) => {
      const usersCollection = mongo().collection("users");
      await usersCollection.updateOne(
        { code: res.locals.user.code },
        {
          $set: {
            firstName: req.body.first_name,
            lastName: req.body.last_name,
            email: req.body.email,
          },
        }
      );

      res.json({
        success: true,
        msg: [
          {
            title: "My Account",
            body: `Your account details have been changed.`,
            status: 1,
            displayTime: 3,
          },
        ],
      });
    })
    .catch((e) => {
      var errorText = e.response.data;

      res.json({
        success: false,
        msg: [
          {
            title: "My Account",
            body: `The server returned an error: ${errorText}`,
            status: 0,
            displayTime: 3,
          },
        ],
      });
    });
});

app.post("/account/changepassword", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];

  const diskosId = axios.create({
    baseURL: `https://id.yourdomain.com/`,
    timeout: 2500,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  diskosId
    .post("account/changepassword", req.body)
    .then(async (resp) => {
      res.json({
        success: true,
        msg: [
          {
            title: "My Account",
            body: `Your account password has been changed.`,
            status: 1,
            displayTime: 3,
          },
        ],
      });
    })
    .catch((e) => {
      var errorText = e.response.data;

      res.json({
        success: false,
        msg: [
          {
            title: "My Account",
            body: `The server returned an error: ${errorText}`,
            status: 0,
            displayTime: 3,
          },
        ],
      });
    });
});

app.get("/account/invoices", async (req, res) => {
  const invoicesCollection = mongo().collection("invoices");

  const userInvoiceItems = await invoicesCollection
    .find({ user: res.locals.user.code })
    .toArray();
  res.json(userInvoiceItems);
});

app.get("/account/invoices/:invoiceId", async (req, res) => {
  const invoicesCollection = mongo().collection("invoices");

  var options = {
    root: path.join(__dirname),
  };

  const invoiceId = req.params.invoiceId;

  const allInvoices = await invoicesCollection.find({}).toArray();

  const invoiceMeta = allInvoices.find((i) => i._id == invoiceId);

  res.sendFile(invoiceMeta.internalFilePath, options);
});

app.get("/account", async (req, res) => {
  var user = res.locals.user;
  delete user._id;
  delete user.code;
  delete user.pterodactylId;
  res.json(user);
});

app.get("/account/servers", async (req, res) => {
  const qemuServers = qemuServersCache.filter(
    (s) => s.user == res.locals.user.code
  );

  const qemuSuspendedServers = qemuServers.filter((s) => s.state == 3);

  const qemuOfflineServers = qemuServers.filter((s) => s.state == 4);

  const pterodactylOwnedServers = pterodactylServerCache.filter(
    (s) => s.user == res.locals.user.pterodactylId
  );
  const pterodactylSuspendedServers = pterodactylOwnedServers.filter(
    (s) => s.suspended == true
  );
  const pterodactylOfflineServers = pterodactylOwnedServers.filter(
    (s) => s.state == 4
  );

  res.json({
    pterodactyl: {
      total: pterodactylOwnedServers.length,
      suspended: pterodactylSuspendedServers.length,
      offline:
        pterodactylOfflineServers.length - pterodactylSuspendedServers.length,
    },
    vps: {
      total: qemuServers.length,
      suspended: qemuSuspendedServers.length,
      offline: qemuOfflineServers.length,
    },
    web: {
      total: 0,
      suspended: 0,
    },
  });
});

//
//
//FUNCTIONS
function pterodactylBilling() {
  return new Promise(async (res) => {
    const usersCollection = mongo().collection("users");
    const serversCollection = mongo().collection("pterodactylServers");
    const invoiceItemsCollection = mongo().collection("invoiceItems");

    const allServers = pterodactylServerCache;
    const allServersPt = await pterodactyl.getServers();

    for (var server of allServers) {
      const allUsers = await usersCollection.find({}).toArray();
      const allServersDb = await serversCollection.find({}).toArray();

      const serverDb = allServersDb.find((s) => s.code == server.uuid);
      const serverPt = allServersPt.find(
        (s) => s.attributes.external_id == server.uuid
      );
      const serverUser = allUsers.find((u) => u.pterodactylId == server.user);

      if (serverDb && serverPt) {
        var billingInterval = parseInt(serverDb?.billingInterval) || 1;
        server.price = parseFloat(parseFloat(server.price).toFixed(2));

        server.price = parseFloat(
          parseFloat(server.price * billingInterval).toFixed(2)
        );

        var date = new Date();
        date.setMonth(date.getMonth() + billingInterval);
        date.setSeconds(0);
        date =
          date.getUTCFullYear() +
          "-" +
          ("00" + (date.getUTCMonth() + 1)).slice(-2) +
          "-" +
          ("00" + date.getUTCDate()).slice(-2) +
          " " +
          ("00" + date.getUTCHours()).slice(-2) +
          ":" +
          ("00" + date.getUTCMinutes()).slice(-2) +
          ":" +
          ("00" + date.getUTCSeconds()).slice(-2);

        var date2 = new Date();
        date2.setSeconds(0);
        date2 =
          date2.getUTCFullYear() +
          "-" +
          ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
          "-" +
          ("00" + date2.getUTCDate()).slice(-2) +
          " " +
          ("00" + date2.getUTCHours()).slice(-2) +
          ":" +
          ("00" + date2.getUTCMinutes()).slice(-2) +
          ":" +
          ("00" + date2.getUTCSeconds()).slice(-2);

        if (serverPt.attributes.suspended == true) {
          if (server.renewal == false) {
            //

            if (serverDb?.packageConfig?.isDedicatedCpu == true) {
              privateServers.deleteServer(server.uuid);
            } else {
              await serversCollection.deleteOne({
                code: server.uuid,
              });

              try {
                await pterodactyl.delete(
                  `application/servers/${serverPt.attributes.id}`
                );

                io.to("serverNode").emit("removeNVMe", {
                  uuid: serverPt.attributes.uuid,
                });
              } catch (e) {}
            }

            //
          } else {
            //

            if (serverUser.balance - server.price >= 0) {
              await usersCollection.updateOne(
                { code: serverUser.code },
                {
                  $set: {
                    balance: parseFloat(
                      (
                        parseFloat(serverUser.balance) -
                        parseFloat(server.price)
                      ).toFixed(3)
                    ),
                  },
                }
              );
              await serversCollection.updateOne(
                {
                  code: server.uuid,
                },
                {
                  $set: {
                    renewDate: date,
                  },
                }
              );

              await invoiceItemsCollection.insertOne({
                billDate: date2,
                nexBillDate: date,
                serverCode: server.uuid,
                serverType: "pterodactyl",
                transaction: {
                  balanceBefore: parseFloat(
                    parseFloat(serverUser.balance).toFixed(3)
                  ),
                  balanceAfter: parseFloat(
                    (
                      parseFloat(serverUser.balance) - parseFloat(server.price)
                    ).toFixed(3)
                  ),
                },
                serverUserCode: serverUser.code,
                serverUserObjectSnapshot: serverUser,
                serverObjectSnapshot: server,
                priceBreakdown: {
                  originalPrice: serverDb.price,
                  discountedPrice: serverDb.price * serverDb?.priceIndex || 1,
                  discountPercentage:
                    100 - (serverDb?.priceIndex - 1 || 0) * 100 - 100,
                },
              });

              function unsuspend() {
                return new Promise((res) => {
                  pterodactyl
                    .post(
                      `application/servers/${serverPt.attributes.id}/unsuspend`
                    )
                    .then(() => {
                      res();
                    })
                    .catch(async (e) => {
                      await unsuspend();
                      res();
                    });
                });
              }

              await unsuspend();
            }

            //
          }
        } else {
          if (server.renewal_cancel_date != "---") {
            const billingDate = new Date(`${server.renewal_cancel_date} UTC`);
            const currentDate = new Date();

            if (currentDate.getTime() >= billingDate.getTime()) {
              if (server.renewal == true) {
                if (serverUser.balance - server.price >= 0) {
                  await usersCollection.updateOne(
                    { code: serverUser.code },
                    {
                      $set: {
                        balance: parseFloat(
                          (
                            parseFloat(serverUser.balance) -
                            parseFloat(server.price)
                          ).toFixed(3)
                        ),
                      },
                    }
                  );

                  await serversCollection.updateOne(
                    {
                      code: server.uuid,
                    },
                    {
                      $set: {
                        renewDate: date,
                      },
                    }
                  );

                  await invoiceItemsCollection.insertOne({
                    billDate: date2,
                    nexBillDate: date,
                    serverCode: server.uuid,
                    serverType: "pterodactyl",
                    transaction: {
                      balanceBefore: parseFloat(
                        parseFloat(serverUser.balance).toFixed(3)
                      ),
                      balanceAfter: parseFloat(
                        (
                          parseFloat(serverUser.balance) -
                          parseFloat(server.price)
                        ).toFixed(3)
                      ),
                    },
                    serverUserCode: serverUser.code,
                    serverUserObjectSnapshot: serverUser,
                    serverObjectSnapshot: server,
                    priceBreakdown: {
                      originalPrice: serverDb.price,
                      discountedPrice:
                        serverDb.price * serverDb?.priceIndex || 1,
                      discountPercentage:
                        100 - (serverDb?.priceIndex - 1 || 0) * 100 - 100,
                    },
                  });
                } else {
                  function suspend() {
                    return new Promise((res) => {
                      pterodactyl
                        .post(
                          `application/servers/${serverPt.attributes.id}/suspend`
                        )
                        .then(() => {
                          res();
                        })
                        .catch(async (e) => {
                          await suspend();
                          res();
                        });
                    });
                  }

                  await suspend();
                }
              } else {
                if (serverDb?.packageConfig?.isDedicatedCpu == true) {
                  privateServers.deleteServer(server.uuid);
                } else {
                  await serversCollection.deleteOne({
                    code: server.uuid,
                  });

                  try {
                    await pterodactyl.delete(
                      `application/servers/${serverPt.attributes.id}`
                    );
                    io.to("serverNode").emit("removeNVMe", {
                      uuid: serverPt.attributes.uuid,
                    });
                  } catch (e) {}
                }
              }
            }
          }
        }
      }
    }
    res();
  });
}

function qemuBilling() {
  return new Promise(async (res) => {
    const serversCollection = mongo().collection("qemuServers");
    const allocationsCollection = mongo().collection("qemuAllocations");
    const usersCollection = mongo().collection("users");
    const invoiceItemsCollection = mongo().collection("invoiceItems");

    var date2 = new Date();
    date2.setSeconds(0);
    date2 =
      date2.getUTCFullYear() +
      "-" +
      ("00" + (date2.getUTCMonth() + 1)).slice(-2) +
      "-" +
      ("00" + date2.getUTCDate()).slice(-2) +
      " " +
      ("00" + date2.getUTCHours()).slice(-2) +
      ":" +
      ("00" + date2.getUTCMinutes()).slice(-2) +
      ":" +
      ("00" + date2.getUTCSeconds()).slice(-2);

    for (var server of qemuServersCache) {
      const serverUser = await usersCollection.findOne({ code: server.user });
      const serverEntry = await serversCollection.findOne({
        code: server.code,
      });
      const serverAllocation = await allocationsCollection.findOne({
        code: serverEntry.allocationId,
      });

      if (serverUser != null && serverEntry != null) {
        var billingInterval = parseInt(serverEntry?.billingInterval) || 1;

        var date = new Date();
        date.setMonth(date.getMonth() + billingInterval);
        date.setSeconds(0);
        date =
          date.getUTCFullYear() +
          "-" +
          ("00" + (date.getUTCMonth() + 1)).slice(-2) +
          "-" +
          ("00" + date.getUTCDate()).slice(-2) +
          " " +
          ("00" + date.getUTCHours()).slice(-2) +
          ":" +
          ("00" + date.getUTCMinutes()).slice(-2) +
          ":" +
          ("00" + date.getUTCSeconds()).slice(-2);

        var serverPrice = parseFloat(
          parseFloat(serverEntry.price * serverEntry?.priceIndex || 1).toFixed(
            2
          )
        );

        serverPrice = parseFloat(
          parseFloat(serverPrice * billingInterval).toFixed(2)
        );

        if (serverEntry.suspended == true) {
          if (serverEntry.renewal == true) {
            if (parseFloat(serverUser.balance) - parseFloat(serverPrice) >= 0) {
              const serverAllocation = await allocationsCollection.findOne({
                code: serverEntry.allocationId,
              });

              var allocationNodeSocket = qemuSockets.find(
                (s) => s.id == serverAllocation.node
              );

              if (allocationNodeSocket) {
                allocationNodeSocket.socket.emit(
                  "unsuspendServer",
                  serverEntry.qemuCode,
                  async function () {
                    await serversCollection.updateOne(
                      {
                        code: serverEntry.code,
                      },
                      {
                        $set: {
                          suspended: false,
                        },
                      }
                    );

                    await invoiceItemsCollection.insertOne({
                      billDate: date2,
                      nexBillDate: date,
                      serverCode: serverEntry.code,
                      serverType: "qemu",
                      transaction: {
                        balanceBefore: parseFloat(
                          parseFloat(serverUser.balance).toFixed(3)
                        ),
                        balanceAfter: parseFloat(
                          (
                            parseFloat(serverUser.balance) -
                            parseFloat(serverPrice)
                          ).toFixed(3)
                        ),
                      },
                      serverUserCode: serverUser.code,
                      serverUserObjectSnapshot: serverUser,
                      serverObjectSnapshot: serverEntry,
                      priceBreakdown: {
                        originalPrice: serverEntry.price,
                        discountedPrice:
                          serverEntry.price * serverEntry?.priceIndex || 1,
                        discountPercentage:
                          100 - (serverEntry?.priceIndex - 1 || 0) * 100 - 100,
                      },
                    });

                    await usersCollection.updateOne(
                      { code: serverUser.code },
                      {
                        $set: {
                          balance: parseFloat(
                            (
                              parseFloat(serverUser.balance) -
                              parseFloat(serverPrice)
                            ).toFixed(3)
                          ),
                        },
                      }
                    );
                    await serversCollection.updateOne(
                      {
                        code: serverEntry.code,
                      },
                      {
                        $set: {
                          renewDate: date,
                        },
                      }
                    );
                  }
                );
              }
            }
          } else {
            var allocationNodeSocket = qemuSockets.find(
              (s) => s.id == serverAllocation.node
            );

            if (allocationNodeSocket) {
              allocationNodeSocket.socket.emit(
                "deleteServer",
                serverEntry.qemuCode,
                async function () {
                  await allocationsCollection.updateOne(
                    {
                      code: serverEntry.allocationId,
                    },
                    {
                      $set: {
                        assigned: false,
                      },
                    }
                  );

                  await serversCollection.deleteOne({
                    code: serverEntry.code,
                  });
                }
              );
            }
          }
        } else {
          const billingDate = new Date(`${serverEntry.renewDate} UTC`);
          const currentDate = new Date();

          //console.log(serverEntry);

          if (currentDate.getTime() >= billingDate.getTime()) {
            if (serverEntry.renewal == false) {
              var allocationNodeSocket = qemuSockets.find(
                (s) => s.id == serverAllocation.node
              );

              if (allocationNodeSocket) {
                allocationNodeSocket.socket.emit(
                  "deleteServer",
                  serverEntry.qemuCode,
                  async function () {
                    await allocationsCollection.updateOne(
                      {
                        code: serverEntry.allocationId,
                      },
                      {
                        $set: {
                          assigned: false,
                        },
                      }
                    );

                    await serversCollection.deleteOne({
                      code: serverEntry.code,
                    });
                  }
                );
              }
            } else {
              if (
                parseFloat(serverUser.balance) - parseFloat(serverPrice) <
                0
              ) {
                var allocationNodeSocket = qemuSockets.find(
                  (s) => s.id == serverAllocation.node
                );

                if (allocationNodeSocket) {
                  allocationNodeSocket.socket.emit(
                    "suspendServer",
                    serverEntry.qemuCode,
                    async function () {
                      await serversCollection.updateOne(
                        {
                          code: serverEntry.code,
                        },
                        {
                          $set: {
                            suspended: true,
                          },
                        }
                      );
                    }
                  );
                }
              } else {
                await usersCollection.updateOne(
                  { code: serverUser.code },
                  {
                    $set: {
                      balance: parseFloat(
                        (
                          parseFloat(serverUser.balance) -
                          parseFloat(serverPrice)
                        ).toFixed(3)
                      ),
                    },
                  }
                );

                await invoiceItemsCollection.insertOne({
                  billDate: date2,
                  nexBillDate: date,
                  serverCode: serverEntry.code,
                  serverType: "qemu",
                  transaction: {
                    balanceBefore: parseFloat(
                      parseFloat(serverUser.balance).toFixed(3)
                    ),
                    balanceAfter: parseFloat(
                      (
                        parseFloat(serverUser.balance) - parseFloat(serverPrice)
                      ).toFixed(3)
                    ),
                  },
                  serverUserCode: serverUser.code,
                  serverUserObjectSnapshot: serverUser,
                  serverObjectSnapshot: serverEntry,
                  priceBreakdown: {
                    originalPrice: serverEntry.price,
                    discountedPrice:
                      serverEntry.price * serverEntry?.priceIndex || 1,
                    discountPercentage:
                      100 - (serverEntry?.priceIndex - 1 || 0) * 100 - 100,
                  },
                });

                await serversCollection.updateOne(
                  {
                    code: serverEntry.code,
                  },
                  {
                    $set: {
                      renewDate: date,
                    },
                  }
                );
              }
            }
          }
        }
      }
    }

    res();
  });
}

async function bill() {
  await qemuBilling();
  await pterodactylBilling();

  setTimeout(() => {
    bill();
  }, 15000);
}

function randomNonce(length) {
  var text = "";
  var possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (var i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
server.listen(serverPort, () => {
  console.log(`[LOG] Example app listening at :${serverPort}`);
});

Array.prototype.equals = function (array) {
  // if the other array is a falsy value, return
  if (!array) return false;

  // compare lengths - can save a lot of time
  if (this.length != array.length) return false;

  for (var i = 0, l = this.length; i < l; i++) {
    // Check if we have nested arrays
    if (this[i] instanceof Array && array[i] instanceof Array) {
      // recurse into the nested arrays
      if (!this[i].equals(array[i])) return false;
    } else if (this[i] != array[i]) {
      // Warning - two different object instances will never be equal: {x:20} != {x:20}
      return false;
    }
  }
  return true;
};
// Hide method from for-in loops
Object.defineProperty(Array.prototype, "equals", { enumerable: false });

setTimeout(() => {
  bill();
}, 1000);

function sleep(timeout) {
  return new Promise((res) => {
    setTimeout(() => {
      res();
    }, timeout);
  });
}

function waitForMongo() {
  return new Promise(async (res) => {
    if (mongo() == null) {
      await sleep(500);
      await waitForMongo();
      res();
    } else {
      setTimeout(() => {
        res();
      }, 1000);
    }
  });
}

var canInvoice = true;
setInterval(() => {
  const date = new Date();
  const lastDayOfTheMonth = getDaysInMonth(
    date.getUTCMonth() + 1,
    date.getUTCFullYear()
  );

  if (
    date.getUTCDate() == lastDayOfTheMonth &&
    date.getUTCHours() == 23 &&
    date.getUTCMinutes() == 59 &&
    canInvoice == true
  ) {
    canInvoice = false;
    invoices();

    setTimeout(() => {
      canInvoice = true;
    }, 600 * 1000);
  }
}, 30 * 1000);

function getDaysInMonth(m, y) {
  return m === 2
    ? y & 3 || (!(y % 25) && y & 15)
      ? 28
      : 29
    : 30 + ((m + (m >> 3)) & 1);
}

waitForMongo().then(() => {
  updateQemuServersCache();
  updatePterodactylServerCache();

  //invoices();

  paypal(app, mongo, io);
});

function run_cmd(cmd) {
  return new Promise((res) => {
    exec(cmd, (error, stdout, stderr) => {
      if (stderr) console.log(stderr);
      res(stdout);
    });
  });
}
