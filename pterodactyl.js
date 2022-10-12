require("dotenv").config();
const axios = require("axios");

const apiToken = process.env.PTERODACTYL_KEY;
var userCache = [];

const pterodactyl = axios.create({
  baseURL: process.env.PTERODACTYL_URL,
  timeout: 2500,
  headers: {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  },
});

function fetchWithPagination(URL) {
  return new Promise(async (res) => {
    var collectedData = [];
    var page = 0;
    var pages = 1;

    while (page < pages) {
      try {
        var request_result = await pterodactyl.get(`${URL}?page=${page + 1}`);

        var payload = request_result.data;

        collectedData = [...collectedData, ...payload.data];

        var pagination_data = request_result.data.meta.pagination;

        pages = pagination_data.total_pages;
        page++;
      } catch (e) {
        console.log(`Retrying fetch... PT`);
      }
    }

    res(collectedData);
  });
}

module.exports = {
  post: pterodactyl.post,
  get: pterodactyl.get,
  delete: pterodactyl.delete,
  patch: pterodactyl.patch,
  getServers() {
    return new Promise(async (res) => {
      var servers = await fetchWithPagination(`application/servers`);
      res(servers);
    });
  },
  getNodes() {
    return new Promise(async (res) => {
      var nodes = await fetchWithPagination(`application/nodes`);
      res(nodes);
    });
  },
  createUser({ email, username, first_name, last_name, external_id }) {
    return new Promise(async (res) => {
      res(
        await pterodactyl.post(`application/users`, {
          external_id,
          email,
          username,
          first_name,
          last_name,
        })
      );
    });
  },
  createServer(CONFIG) {
    return new Promise(async (res) => {
      console.log(CONFIG) //
      res(await pterodactyl.post(`application/servers`, CONFIG));
    });
  },
  getEggs() {
    return new Promise(async (res) => {
      var eggs = [];

      var nests = await fetchWithPagination(`application/nests`);

      var nestPromises = [];

      for (var nest of nests) {
        nestPromises.push(
          pterodactyl.get(
            `application/nests/${nest.attributes.id}/eggs?include=nest,servers`
          )
        );
      }

      nestPromises = await Promise.all(nestPromises);

      for (var nest of nestPromises) {
        eggs = [...eggs, ...nest.data.data];
      }

      res(eggs);
    });
  },

  getAllocations(NODE_ID) {
    return new Promise(async (res) => {
      var allocations = [];
      if (NODE_ID) {
        var node_allocations = await fetchWithPagination(
          `application/nodes/${NODE_ID}/allocations`
        );
        allocations = [...allocations, ...node_allocations];
        res(allocations);
      } else {
        var nodes = await fetchWithPagination(`application/nodes`);
        var allocations = [];
        for (var node of nodes) {
          var node_allocations = await fetchWithPagination(
            `application/nodes/${node.attributes.id}/allocations`
          );

          for (var allocation_index in node_allocations) {
            node_allocations[allocation_index].node = node.attributes.id;
          }

          allocations = [...allocations, ...node_allocations];
        }
        res(allocations);
      }
    });
  },
  getLocations() {
    return new Promise(async (res) => {
      var locations = await fetchWithPagination(`application/locations`);
      res(locations);
    });
  },
  getUsers() {
    return new Promise(async (res) => {
      var users = await fetchWithPagination(`application/users`);
      res(users);
    });
  },
};
