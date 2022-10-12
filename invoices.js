var mongo = require("./mongodb");
var https = require("https");
var fs = require("fs");
const { v4: uuidv4 } = require("uuid");

function generateInvoice(invoice, filename, success, error) {
  var postData = JSON.stringify(invoice);
  var options = {
    hostname: "invoice-generator.com",
    port: 443,
    path: "/",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
  };

  var file = fs.createWriteStream(filename);

  var req = https.request(options, function (res) {
    res
      .on("data", function (chunk) {
        file.write(chunk);
      })
      .on("end", function () {
        file.end();

        if (typeof success === "function") {
          success();
        }
      });
  });
  req.write(postData);
  req.end();

  if (typeof error === "function") {
    req.on("error", error);
  }
}

module.exports = async function () {
  const usersCollection = mongo().collection("users");
  const users = await usersCollection
    .find()
    .toArray();
  const invoiceItemsCollection = mongo().collection("invoiceItems");
  const invoicesCollection = mongo().collection("invoices");

  for (const user of users) {
    await new Promise(async (res) => {
      const userCode = user.code;
      const userInvoiceItems = await invoiceItemsCollection
        .find({ serverUserCode: userCode })
        .toArray();

      if (userInvoiceItems.length == 0) {
        res();
        return;
      }

      const invoiceItems = [];
      var itemsTotal = 0;
      var userName = `${user.firstName} ${user.lastName}`;

      var discountTotal = 0;
      var discountTotalRaw = 0;

      for (var invoiceItem of userInvoiceItems) {
        if (invoiceItem.serverType == "pterodactyl") {
          var serverNotes = [];

          var serverPrice =
            parseFloat(
              parseFloat(invoiceItem?.priceBreakdown?.originalPrice).toFixed(2)
            ) || invoiceItem.serverObjectSnapshot.price;

          if (invoiceItem.serverObjectSnapshot.stateText == "Suspended")
            serverNotes.push("Server was suspended");

          var ram =
            invoiceItem.serverObjectSnapshot.specs.ram >= 1
              ? `${invoiceItem.serverObjectSnapshot.specs.ram} GB`
              : `${invoiceItem.serverObjectSnapshot.specs.ram * 1024} MB`;
          var disk =
            invoiceItem.serverObjectSnapshot.specs.disk >= 1
              ? `${invoiceItem.serverObjectSnapshot.specs.disk} GB`
              : `${invoiceItem.serverObjectSnapshot.specs.disk * 1024} MB`;

          const invoiceObject = {
            name: `${
              invoiceItem.serverObjectSnapshot.package || `Pterodactyl`
            } - ${invoiceItem.serverObjectSnapshot.name}`,
            description: `${
              invoiceItem.serverObjectSnapshot.specs.cpu
            } CPU CORE${
              invoiceItem.serverObjectSnapshot.specs.cpu != 1 ? "S" : ""
            } | ${ram} MEMORY | ${disk} DISK\n${invoiceItem.billDate} - ${
              invoiceItem.nexBillDate
            }\n`,
            unit_cost: serverPrice,
            quantity: invoiceItem?.serverObjectSnapshot?.billingInterval || 1,
          };

          if (invoiceItem.priceBreakdown) {
            discountTotal =
              discountTotal +
              parseFloat(
                parseFloat(
                  parseFloat(
                    invoiceItem.priceBreakdown.originalPrice -
                      parseFloat(
                        invoiceItem.priceBreakdown.discountedPrice
                      ).toFixed(2)
                  ).toFixed(2) *
                    (invoiceItem?.serverObjectSnapshot?.billingInterval || 1)
                ).toFixed(2)
              );

            invoiceObject.description += `${
              invoiceItem?.serverObjectSnapshot?.billingInterval || 1
            } month discount: ${
              invoiceItem.priceBreakdown.discountPercentage
            }%\n`;
          }

          invoiceItems.push(invoiceObject);

          itemsTotal +=
            serverPrice * (invoiceItem?.serverObjectSnapshot?.billingInterval ||
            1);
        }

        if (invoiceItem.serverType == "qemu") {
          var ram =
            invoiceItem.serverObjectSnapshot.specs.ram > 1023
              ? `${invoiceItem.serverObjectSnapshot.specs.ram / 1024} GB`
              : `${invoiceItem.serverObjectSnapshot.specs.ram} MB`;
          var disk =
            invoiceItem.serverObjectSnapshot.specs.disk > 1023
              ? `${invoiceItem.serverObjectSnapshot.specs.disk / 1024} GB`
              : `${invoiceItem.serverObjectSnapshot.specs.disk} MB`;

          var serverPrice =
            parseFloat(
              parseFloat(invoiceItem?.priceBreakdown?.originalPrice).toFixed(2)
            ) || invoiceItem.serverObjectSnapshot.price;

          var invoiceObject = {
            name: `VPS - ${invoiceItem.serverObjectSnapshot.name}`,
            description: `${
              invoiceItem.serverObjectSnapshot.specs.cpu
            } vCPU CORE${
              invoiceItem.serverObjectSnapshot.specs.cpu != 1 ? "S" : ""
            } | ${ram} MEMORY | ${disk} DISK\n${invoiceItem.billDate} - ${
              invoiceItem.nexBillDate
            }\n`,
            unit_cost: serverPrice,
            quantity: invoiceItem?.serverObjectSnapshot?.billingInterval || 1,
          };

          if (invoiceItem.priceBreakdown) {
            discountTotal =
              discountTotal +
              parseFloat(
                parseFloat(
                  parseFloat(
                    invoiceItem.priceBreakdown.originalPrice -
                      parseFloat(
                        invoiceItem.priceBreakdown.discountedPrice
                      ).toFixed(2)
                  ).toFixed(2) *
                    (invoiceItem?.serverObjectSnapshot?.billingInterval || 1)
                ).toFixed(2)
              );
          }

          invoiceObject.description += `${
            invoiceItem?.serverObjectSnapshot?.billingInterval || 1
          } month discount: ${
            invoiceItem.priceBreakdown.discountPercentage
          }%\n`;

          invoiceItems.push(invoiceObject);

          itemsTotal +=
            serverPrice * (invoiceItem?.serverObjectSnapshot?.billingInterval ||
            1);
        }
      }

      console.log(discountTotal);

      var invoice = {
        logo: "https://preview.diskcraft.xyz/img/diskcraft3.75fea036.png",
        from: "DiskCraft",
        to: userName,
        custom_fields: [
          {
            name: "Account Number",
            value: userCode,
          },
        ],
        fields: { discounts: true, shipping: false },
        currency: "usd",
        number: `INV-${uuidv4().split("-")[0]}${uuidv4().split("-")[1]}`,
        payment_terms: "Auto-Billed - Do Not Pay",
        items: invoiceItems,
        discounts: discountTotal,
        amount_paid: itemsTotal - discountTotal,
        terms: "No need to submit payment. You have already paid this invoice.",
      };

      generateInvoice(
        invoice,
        `invoices/${invoice.number}.pdf`,
        async function () {
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

          await invoicesCollection.insertOne({
            user: userCode,
            date: date,
            total: itemsTotal,
            internalFilePath: `invoices/${invoice.number}.pdf`,
          });

          await invoiceItemsCollection.deleteMany({
            serverUserCode: userCode,
          });

          res();
        },
        function (error) {
          console.error(error);
          res();
        }
      );
    });
  }
};
