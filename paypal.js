const paypal = require("@paypal/checkout-server-sdk");
require("dotenv").config();
let environment;

if (process.env.PAYPAL_SANDBOX == false || process.env.PAYPAL_SANDBOX == "false") {
  environment = new paypal.core.LiveEnvironment(
    process.env.PAYPAL_LIVE_CLIENTID,
    process.env.PAYPAL_LIVE_PRIVATE
  );
} else {
  environment = new paypal.core.SandboxEnvironment(
    process.env.PAYPAL_SANDBOX_CLIENTID,
    process.env.PAYPAL_SANDBOX_PRIVATE
  );
}
let client = new paypal.core.PayPalHttpClient(environment);

function main(app, mongo, io) {
  //WEBHOOK - reserved for future use
  app.post("/paypal/transactionbackend/hook", (req, res) => {
    console.log(req.body); // Call your action on the request here
    res.status(200).end(); // Responding is important
  });

  app.post("/paypal/createtransaction", async (req, res) => {
    const transactionsCollection = mongo().collection(
      "paypalPendingTransactions"
    );

    const amount = req.body.amount || 5;

    if (amount > 250 || amount < 5) {
      res.json({
        success: false,
        msg: [
          {
            title: "PayPal",
            body: "The selected amount is invalid.",
            displayTime: 3,
            status: 0,
          },
        ],
      });
      return;
    }

    let request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: "CAPTURE",
      application_context: {
        return_url: `https://billing.yourdomain.com/paypalreturn?status=ok`,
        cancel_url: `https://billing.yourdomain.com/paypalreturn?status=cancel`,
        brand_name: "DiskCraft",
      },
      purchase_units: [
        {
          reference_id: res.locals.user.code,
          custom_id: res.locals.user.code,
          amount: {
            currency_code: "USD",
            value: amount,
            breakdown: {
              item_total: {
                currency_code: "USD",
                value: amount,
              },
            },
          },
          items: [
            {
              name: "Credit",
              sku: "item",
              unit_amount: {
                value: amount,
                currency_code: "USD",
              },

              quantity: 1,
            },
          ],
        },
      ],
    });

    let response = await client.execute(request);

    var transactionTime = new Date();
    transactionTime = transactionTime.getTime();

    await transactionsCollection.insertOne({
      request,
      response,
      user: res.locals.user,
      timestamp: transactionTime,
    });

    res.json({
      checkout_url: response.result.links[1].href,
    });
  });

  checkPendingTransactions(mongo);

  setInterval(() => {
    checkPendingTransactions(mongo);
  }, 100 * 1000);
}

async function checkPendingTransactions(mongo) {
  const transactionsCollection = mongo().collection(
    "paypalPendingTransactions"
  );
  const pendingTransactions = await transactionsCollection.find({}).toArray();

  var time = new Date();
  time.setHours(time.getHours() - 6);
  time = time.getTime();

  for (var transaction of pendingTransactions) {
    if (time > transaction.timestamp) {
      //transaction expired;

      await transactionsCollection.deleteOne({
        _id: transaction._id,
      });
    } else {
      //transaction is still valid;
      await handlePaypalTransaction(transaction, mongo);
    }
  }
}

function handlePaypalTransaction(transaction, mongo) {
  return new Promise(async (res) => {
    const captureId = transaction.response.result.id;
    const captureAmount =
      transaction.request.body.purchase_units[0].amount.value;

    const statusRequest = new paypal.orders.OrdersGetRequest(captureId);
    const captureStatus = await client.execute(statusRequest);
    const captureStatusCode = captureStatus.result.status;

    //complete the order and give the user credit
    if (captureStatusCode == "COMPLETED" || captureStatusCode == "APPROVED") {
      //accept the transaction;
      try {
        const transactionAcceptRequest = new paypal.orders.OrdersCaptureRequest(
          captureId
        );
        const transactionAcceptResult = await client.execute(
          transactionAcceptRequest
        );
      } catch (e) {
        //ignore, transaction has already been accepted
      }

      const userCode = transaction.user.code;

      const completedTransactionsCollection = mongo().collection(
        "paypalCompletedTransactions"
      );
      const pendingTransactionsCollection = mongo().collection(
        "paypalPendingTransactions"
      );
      const usersCollection = mongo().collection("users");

      const transactionObject = {
        transaction,
        updatedTransaction: captureStatus,
      };

      await completedTransactionsCollection.insertOne(transactionObject);
      const user = await usersCollection.findOne({ code: userCode });
      await pendingTransactionsCollection.deleteOne({
        _id: transaction._id,
      });

      const newBalance = (
        parseFloat(user.balance) + parseFloat(captureAmount)
      ).toFixed(3);

      await usersCollection.updateOne(user, {
        $set: {
          balance: parseFloat(newBalance),
        },
      });

      //END OF TRANSACTION
    }

    // console.log(captureStatus);
  });
}

module.exports = main;
