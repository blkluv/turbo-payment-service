/**
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import Arweave from "arweave/node/common";
import { expect } from "chai";
import { Server } from "http";
import { sign } from "jsonwebtoken";
import { spy, stub } from "sinon";
import Stripe from "stripe";

import {
  CurrencyLimitations,
  TEST_PRIVATE_ROUTE_SECRET,
  paymentAmountLimits,
} from "../src/constants";
import { tableNames } from "../src/database/dbConstants";
import {
  ChargebackReceiptDBResult,
  PaymentReceiptDBResult,
  UserDBResult,
} from "../src/database/dbTypes.js";
import logger from "../src/logger";
import {
  CoingeckoArweaveToFiatOracle,
  ReadThroughArweaveToFiatOracle,
} from "../src/pricing/oracles/arweaveToFiatOracle";
import { TurboPricingService } from "../src/pricing/pricing";
import { createServer } from "../src/server";
import { supportedPaymentCurrencyTypes } from "../src/types/supportedCurrencies";
import { Winston } from "../src/types/winston";
import { signedRequestHeadersFromJwk } from "../tests/helpers/signData";
import {
  chargeDisputeStub,
  checkoutSessionStub,
  checkoutSessionSuccessStub,
  expectedAdjustments,
  expectedArPrices,
  expectedRates,
  paymentIntentStub,
  stripeResponseStub,
  stripeStubEvent,
  stubTxId1,
} from "./helpers/stubs";
import { assertExpectedHeadersWithContentLength } from "./helpers/testExpectations";
import {
  axios,
  coinGeckoAxios,
  coinGeckoOracle,
  dbTestHelper,
  paymentDatabase,
  pricingService,
  stripe,
  testAddress,
  testWallet,
} from "./helpers/testHelpers";

describe("Router tests", () => {
  let server: Server;

  function closeServer() {
    server.close();
    logger.info("Server closed!");
  }

  before(async () => {
    server = await createServer({ pricingService, paymentDatabase, stripe });
  });

  after(() => {
    closeServer();
  });

  it("GET /health returns 'OK' in the body, a 200 status, and the correct content-length", async () => {
    const { status, statusText, headers, data } = await axios.get("/health");

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    assertExpectedHeadersWithContentLength(headers, 2);

    expect(data).to.equal("OK");
  });

  it("GET /price/bytes", async () => {
    const wincTotal = new Winston("1234567890");
    stub(pricingService, "getWCForBytes").resolves({
      winc: wincTotal,
      adjustments: [],
    });

    const { status, statusText, data } = await axios.get(
      `/v1/price/bytes/1024`
    );
    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    expect(+new Winston(data.winc)).to.equal(1234567890);
  });

  it("GET /price/bytes returns 400 for bytes > max safe integer", async () => {
    const { status, statusText, data } = await axios.get(
      `/v1/price/bytes/1024000000000000000000000000000000000000000000`
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
    expect(data).to.equal("Byte count too large");
  });

  it("GET /price/bytes returns 400 for invalid byte count", async () => {
    const { status, statusText, data } = await axios.get(
      `/v1/price/bytes/-54.2`
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
    expect(data).to.equal("Invalid byte count");
  });

  it("GET /price/bytes returns 502 if bytes pricing oracle fails to get a price", async () => {
    stub(pricingService, "getWCForBytes").throws(Error("Serious failure"));
    const { status, statusText, data } = await axios.get(
      `/v1/price/bytes/1321321`
    );
    expect(status).to.equal(502);
    expect(data).to.equal("Pricing Oracle Unavailable");
    expect(statusText).to.equal("Bad Gateway");
  });

  it("GET /price/:currency/:value returns 502 if fiat pricing oracle response is unexpected", async () => {
    stub(coinGeckoAxios, "get").resolves({
      data: {
        arweave: {
          weird: "types",
          from: ["c", 0, "in", "ge", "ck", 0],
        },
      },
    });
    const { data, status, statusText } = await axios.get(`/v1/price/usd/5000`);

    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
    expect(data).to.equal("Fiat Oracle Unavailable");
  });

  it("GET /rates returns 502 if unable to fetch prices", async () => {
    stub(coinGeckoOracle, "getFiatPricesForOneAR").throws();
    const { status, statusText } = await axios.get(`/v1/rates`);

    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
  });

  it("GET /rates returns the correct response", async () => {
    stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
      expectedArPrices.arweave
    );
    const { data, status, statusText } = await axios.get(`/v1/rates`);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    expect(data).to.deep.equal({
      ...expectedRates,
      adjustments: expectedAdjustments,
    });
  });

  it("GET /rates/:currency returns 404 for non supported currency", async () => {
    const { status, statusText, data } = await axios.get(`/v1/rates/abc`);
    expect(status).to.equal(404);
    expect(statusText).to.equal("Not Found");
    expect(data).to.equal("Invalid currency.");
  });

  it("GET /rates/:currency returns 502 if unable to fetch prices", async () => {
    stub(pricingService, "getFiatPriceForOneAR").throws();
    const { status, statusText } = await axios.get(`/v1/rates/usd`);
    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
  });

  it("GET /rates/:currency returns the correct response for supported currency", async () => {
    stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
      expectedArPrices.arweave
    );
    const { data, status, statusText } = await axios.get(`/v1/rates/usd`);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    expect(data).to.deep.equal({
      currency: "usd",
      rate: expectedArPrices.arweave.usd,
    });
  });

  it("GET /price/:currency/:value", async () => {
    stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
      expectedArPrices.arweave
    );
    const { status, statusText, data } = await axios.get(`/v1/price/USD/100`);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    expect(+new Winston(data.winc)).to.equal(109686609687);
  });

  it("GET /price/:currency/:value returns 400 for invalid currency", async () => {
    const { data, status, statusText } = await axios.get(
      `/v1/price/RandomCurrency/100`
    );
    expect(data).to.equal(
      // cspell:disable
      "The currency type 'randomcurrency' is currently not supported by this API!" // cspell:enable
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
  });

  it("GET /price/:currency/:value returns 400 for an invalid payment amount", async () => {
    const { data, status, statusText } = await axios.get(`/v1/price/usd/200.5`);
    expect(data).to.equal(
      "The provided payment amount (200.5) is invalid; it must be a positive non-decimal integer!"
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
  });

  it("GET /price/:currency/:value returns 502 if fiat pricing oracle fails to get a price", async () => {
    stub(pricingService, "getWCForPayment").throws(Error("Really bad failure"));
    const { data, status, statusText } = await axios.get(`/v1/price/usd/5000`);

    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
    expect(data).to.equal("Fiat Oracle Unavailable");
  });

  before(async () => {
    await dbTestHelper.insertStubUser({
      user_address: testAddress,
      winston_credit_balance: "5000000",
    });
  });

  it("GET /balance returns 200 for correct signature", async () => {
    const { status, statusText, data } = await axios.get(`/v1/balance`, {
      headers: await signedRequestHeadersFromJwk(testWallet, "123"),
    });

    const balance = Number(data.winc);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    expect(balance).to.equal(5000000);
  });

  it("GET /balance returns 404 for no user found", async function () {
    this.timeout(5_000);
    const jwk = await Arweave.crypto.generateJWK();

    const { status, statusText, data } = await axios.get(`/v1/balance`, {
      headers: await signedRequestHeadersFromJwk(jwk, "123"),
    });

    expect(status).to.equal(404);
    expect(statusText).to.equal("Not Found");

    expect(data).to.equal("User Not Found");
  });

  it("GET /balance returns 403 for bad signature", async () => {
    const { status, data, statusText } = await axios.get(`/v1/balance`, {
      headers: {
        ...(await signedRequestHeadersFromJwk(testWallet, "123")),
        "x-nonce": "a fake different nonce that will not match",
      },
    });

    expect(status).to.equal(403);
    expect(statusText).to.equal("Forbidden");

    expect(data).to.equal("Invalid signature or missing required headers");
  });

  it("GET /balance returns 503 when the database cannot be reached", async () => {
    stub(paymentDatabase, "getBalance").throws(Error("Whoops!"));
    const { status, data, statusText } = await axios.get(`/v1/balance`, {
      headers: await signedRequestHeadersFromJwk(testWallet),
    });

    expect(status).to.equal(503);
    expect(statusText).to.equal("Service Unavailable");
    expect(data).to.equal("Cloud Database Unavailable");
  });

  it("GET /top-up/checkout-session returns 200 and correct response for correct signature", async () => {
    const amount = 1000;
    const checkoutStub = stub(stripe.checkout.sessions, "create").resolves(
      stripeResponseStub({
        ...checkoutSessionSuccessStub,
        amount_total: amount,
      })
    );
    stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
      expectedArPrices.arweave
    );

    const { status, statusText, data } = await axios.get(
      `/v1/top-up/checkout-session/${testAddress}/usd/${amount}`
    );

    expect(data).to.have.property("topUpQuote");
    expect(data).to.have.property("paymentSession");
    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    const { object, payment_method_types, amount_total, url } =
      data.paymentSession;

    expect(object).to.equal("checkout.session");
    expect(payment_method_types).to.deep.equal(["card"]);
    expect(amount_total).to.equal(amount);
    expect(url).to.be.a.string;
    checkoutStub.restore();
  });

  it("GET /top-up/payment-intent returns 200 and correct response for correct signature", async () => {
    const topUpAmount = 1000;
    const paymentIntentStubSpy = stub(stripe.paymentIntents, "create").resolves(
      stripeResponseStub({
        ...paymentIntentStub({
          amount: topUpAmount,
          status: "requires_payment_method",
        }),
      })
    );

    stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
      expectedArPrices.arweave
    );

    const { status, statusText, data } = await axios.get(
      `/v1/top-up/payment-intent/${testAddress}/usd/${topUpAmount}`
    );

    expect(data).to.have.property("topUpQuote");
    expect(data).to.have.property("paymentSession");
    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");

    const {
      object,
      payment_method_types,
      amount,
      currency,
      client_secret,
      metadata,
      status: paymentStatus,
    } = data.paymentSession;

    expect(object).to.equal("payment_intent");
    expect(payment_method_types).to.deep.equal(["card"]);
    expect(amount).to.equal(topUpAmount);
    expect(currency).to.equal("usd");
    expect(client_secret).to.be.a.string;
    expect(metadata.topUpQuoteId).to.be.a.string;
    expect(paymentStatus).to.equal("requires_payment_method");
    paymentIntentStubSpy.restore();
  });

  it("GET /top-up returns 403 for bad arweave address", async () => {
    const { status, statusText, data } = await axios.get(
      `/v1/top-up/checkout-session/BAD_ADDRESS_OF_DOOM/usd/100`
    );
    expect(status).to.equal(403);
    expect(data).to.equal(
      "Destination address is not a valid Arweave native address!"
    );
    expect(statusText).to.equal("Forbidden");
  });

  it("GET /top-up returns 400 for invalid payment method", async () => {
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/some-method/${testAddress}/usd/101`
    );

    expect(data).to.equal(
      "Payment method must include one of: payment-intent,checkout-session!"
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
  });

  it("GET /top-up returns 400 for invalid currency", async () => {
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/payment-intent/${testAddress}/currencyThatDoesNotExist/100`
    );

    expect(data).to.equal(
      // cspell:disable
      "The currency type 'currencythatdoesnotexist' is currently not supported by this API!"
      // cspell:enable
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
  });

  it("GET /top-up returns 400 for invalid payment amount", async () => {
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/checkout-session/${testAddress}/usd/-984`
    );

    expect(data).to.equal(
      "The provided payment amount (-984) is invalid; it must be a positive non-decimal integer!"
    );
    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
  });

  it("GET /top-up returns 502 when fiat pricing oracle is unreachable", async () => {
    stub(pricingService, "getWCForPayment").throws(Error("Oh no!"));
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/checkout-session/${testAddress}/usd/1337`
    );

    expect(data).to.equal("Fiat Oracle Unavailable");
    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
  });

  // Ensure that we can handle all of our own exposed currency limitations
  describe("currency limitation tests", () => {
    let currencyLimitations: CurrencyLimitations;
    before(async () => {
      currencyLimitations = (await axios.get(`v1/currencies`)).data.limits;
    });

    it("GET /top-up returns 200 for max and min payment amounts for each currency", async () => {
      const checkoutSessionStubSpy = stub(
        stripe.checkout.sessions,
        "create"
      ).resolves(stripeResponseStub(checkoutSessionStub({})));
      stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
        expectedArPrices.arweave
      );

      // Get maximum price for each supported currency concurrently
      const maxPriceResponses = await Promise.all(
        supportedPaymentCurrencyTypes.map((currencyType) =>
          axios.get(
            `/v1/top-up/checkout-session/${testAddress}/${currencyType}/${currencyLimitations[currencyType].maximumPaymentAmount}`
          )
        )
      );
      for (const res of maxPriceResponses) {
        expect(res.status).to.equal(200);
      }

      // Get minimum price for each supported currency concurrently
      const minPriceResponses = await Promise.all(
        supportedPaymentCurrencyTypes.map((currencyType) =>
          axios.get(
            `/v1/top-up/checkout-session/${testAddress}/${currencyType}/${currencyLimitations[currencyType].minimumPaymentAmount}`
          )
        )
      );
      for (const { status } of minPriceResponses) {
        expect(status).to.equal(200);
      }
      checkoutSessionStubSpy.restore();
    });

    it("GET /top-up returns 400 for a payment amount too large in each supported currency", async () => {
      stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
        expectedArPrices.arweave
      );

      for (const currencyType of supportedPaymentCurrencyTypes) {
        const maxAmountAllowed =
          currencyLimitations[currencyType].maximumPaymentAmount;

        const { data, status, statusText } = await axios.get(
          `/v1/top-up/checkout-session/${testAddress}/${currencyType}/${
            maxAmountAllowed + 1
          }`
        );

        expect(data).to.equal(
          `The provided payment amount (${
            maxAmountAllowed + 1
          }) is too large for the currency type "${currencyType}"; it must be below or equal to ${maxAmountAllowed}!`
        );
        expect(status).to.equal(400);
        expect(statusText).to.equal("Bad Request");
      }
    });

    it("GET /top-up returns 400 for a payment amount too small in each supported currency", async () => {
      stub(coinGeckoOracle, "getFiatPricesForOneAR").resolves(
        expectedArPrices.arweave
      );

      for (const currencyType of supportedPaymentCurrencyTypes) {
        const minAmountAllowed =
          currencyLimitations[currencyType].minimumPaymentAmount;

        const { data, status, statusText } = await axios.get(
          `/v1/top-up/checkout-session/${testAddress}/${currencyType}/${
            minAmountAllowed - 1
          }`
        );

        expect(data).to.equal(
          `The provided payment amount (${
            minAmountAllowed - 1
          }) is too small for the currency type "${currencyType}"; it must be above ${minAmountAllowed}!`
        );
        expect(status).to.equal(400);
        expect(statusText).to.equal("Bad Request");
      }
    });
  });

  it("GET /top-up returns 502 when stripe fails to create payment session", async () => {
    const checkoutStub = stub(stripe.checkout.sessions, "create").throws(
      Error("Oh no!")
    );
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/checkout-session/${testAddress}/usd/1337`
    );

    expect(data).to.equal(
      "Error creating stripe payment session with method: checkout-session!"
    );
    expect(status).to.equal(502);
    expect(statusText).to.equal("Bad Gateway");
    checkoutStub.restore();
  });

  it("GET /top-up returns 503 when database is unreachable", async () => {
    stub(stripe.checkout.sessions, "create").resolves(
      stripeResponseStub(checkoutSessionStub({}))
    );
    stub(paymentDatabase, "createTopUpQuote").throws(Error("Bad news"));
    const { status, data, statusText } = await axios.get(
      `/v1/top-up/checkout-session/${testAddress}/usd/1337`
    );

    expect(data).to.equal("Cloud Database Unavailable");
    expect(status).to.equal(503);
    expect(statusText).to.equal("Service Unavailable");
  });

  it("GET /reserve-balance returns 200 for correct params", async () => {
    const testAddress = "a stub address";
    await dbTestHelper.insertStubUser({
      user_address: testAddress,
      winston_credit_balance: "1000000000",
    });

    const byteCount = 1;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const adjustedWincTotal = new Winston("100");
    stub(pricingService, "getWCForBytes").resolves({
      winc: adjustedWincTotal,
      adjustments: [],
    });

    const { status, statusText, data } = await axios.get(
      `/v1/reserve-balance/${testAddress}?byteCount=${byteCount}&dataItemId=${stubTxId1}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("Balance reserved");
    expect(status).to.equal(200);
    expect(data).to.equal("100");
  });

  it("GET /reserve-balance returns 200 for correct params using legacy route", async () => {
    const testAddress = "a stub address 2";
    await dbTestHelper.insertStubUser({
      user_address: testAddress,
      winston_credit_balance: "1000000000",
    });

    const byteCount = 1;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const wincTotal = new Winston("100");
    stub(pricingService, "getWCForBytes").resolves({
      winc: wincTotal,
      adjustments: [],
    });

    const { status, statusText, data } = await axios.get(
      `/v1/reserve-balance/${testAddress}/${byteCount}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("Balance reserved");
    expect(status).to.equal(200);
    expect(data).to.equal("100");
  });

  it("GET /reserve-balance returns 401 for missing authorization", async () => {
    const byteCount = 1000;

    const { status, statusText } = await axios.get(
      `/v1/reserve-balance/${testAddress}?byteCount=${byteCount}&dataItemId=${stubTxId1}`
    );
    expect(statusText).to.equal("Unauthorized");
    expect(status).to.equal(401);
  });

  it("GET /reserve-balance returns 402 for insufficient balance", async () => {
    const byteCount = 100000;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const { status, statusText } = await axios.get(
      `/v1/reserve-balance/${testAddress}?byteCount=${byteCount}&dataItemId=${stubTxId1}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("Insufficient balance");
    expect(status).to.equal(402);
  });

  it("GET /reserve-balance returns 404 if user not found", async () => {
    const testAddress = "someRandomAddress";
    const byteCount = 100000;

    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const { status, statusText } = await axios.get(
      `/v1/reserve-balance/${testAddress}?byteCount=${byteCount}&dataItemId=${stubTxId1}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("User not found");
    expect(status).to.equal(404);
  });

  it("GET /refund-balance returns 200 for correct params", async () => {
    const winstonCredits = 1000;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const { status, statusText } = await axios.get(
      `/v1/refund-balance/${testAddress}?winstonCredits=${winstonCredits}&dataItemId=${stubTxId1}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("Balance refunded");
    expect(status).to.equal(200);
  });

  it("GET /refund-balance returns 200 for correct params for legacy route", async () => {
    const winstonCredits = 1000;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const { status, statusText } = await axios.get(
      `/v1/refund-balance/${testAddress}/${winstonCredits}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    expect(statusText).to.equal("Balance refunded");
    expect(status).to.equal(200);
  });

  it("GET /refund-balance returns 401 for missing authorization", async () => {
    const winstonCredits = 1000;

    const { status, statusText } = await axios.get(
      `/v1/refund-balance/${testAddress}?winstonCredits=${winstonCredits}&dataItemId=${stubTxId1}`
    );
    expect(statusText).to.equal("Unauthorized");
    expect(status).to.equal(401);
  });

  it("GET /refund-balance returns 404 if user not found", async () => {
    const testAddress = "someRandomAddress";
    const winstonCredits = 100000;
    const token = sign({}, TEST_PRIVATE_ROUTE_SECRET, {
      expiresIn: "1h",
    });

    const { status, statusText } = await axios.get(
      `/v1/refund-balance/${testAddress}?winstonCredits=${winstonCredits}&dataItemId=${stubTxId1}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    expect(statusText).to.equal("User not found");
    expect(status).to.equal(404);
  });

  it("GET /currencies returns status 200 and the expected list of currencies and limits", async () => {
    const { status, statusText, data } = await axios.get(`/v1/currencies`);

    expect(data.supportedCurrencies).to.deep.equal(
      supportedPaymentCurrencyTypes
    );
    expect(data.limits).to.exist;
    expect(statusText).to.equal("OK");
    expect(status).to.equal(200);
  });

  // We expect to return 200 OK on all stripe webhook events we handle regardless of how we handle the event
  it("POST /stripe-webhook returns 200 for valid stripe dispute event", async () => {
    const disputeEventPaymentReceiptId = "A Payment Receipt Id to Dispute 👊🏻";
    const disputeEventUserAddress = "User Address to Dispute 🤺";
    const topUpQuoteId = "0x1234567890";
    const paymentIntent = paymentIntentStub({
      metadata: {
        disputeEventUserAddress,
        topUpQuoteId,
      },
    });
    const dispute = chargeDisputeStub({
      paymentIntent: paymentIntent.id,
    });

    const paymentIntentResponse: Stripe.Response<Stripe.PaymentIntent> = {
      ...paymentIntent,
      lastResponse: {
        headers: {},
        requestId: "test-response",
        statusCode: 200,
      },
    };

    const paymentIntentResponseStub = stub(
      stripe.paymentIntents,
      "retrieve"
    ).resolves(paymentIntentResponse);

    // Insert payment receipt and user that dispute event depends on
    await dbTestHelper.insertStubUser({
      user_address: disputeEventUserAddress,
      winston_credit_balance: "1000",
    });

    await dbTestHelper.insertStubPaymentReceipt({
      payment_receipt_id: disputeEventPaymentReceiptId,
      winston_credit_amount: "50",
      top_up_quote_id: topUpQuoteId,
      destination_address: disputeEventUserAddress,
    });

    const stubEvent = stripeStubEvent({
      type: "charge.dispute.created",
      eventObject: dispute,
    });

    const eventStub = stub(stripe.webhooks, "constructEvent").returns(
      stubEvent
    );

    const { status, statusText, data } = await axios.post(`/v1/stripe-webhook`);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");
    expect(data).to.equal("OK");

    // wait a few seconds for the database to update since we return the response right away
    await new Promise((resolve) => setTimeout(resolve, 500));

    const chargebackReceipt = await paymentDatabase[
      "knexReader"
    ]<ChargebackReceiptDBResult>(tableNames.chargebackReceipt).where({
      payment_receipt_id: disputeEventPaymentReceiptId,
    });
    expect(chargebackReceipt.length).to.equal(1);

    const {
      payment_amount,
      currency_type,
      destination_address,
      destination_address_type,
      payment_provider,
      chargeback_receipt_date,
      chargeback_receipt_id,
      payment_receipt_id,
      winston_credit_amount,
      chargeback_reason,
    } = chargebackReceipt[0];

    expect(payment_amount).to.equal("100");
    expect(currency_type).to.equal("usd");
    expect(destination_address).to.equal(disputeEventUserAddress);
    expect(destination_address_type).to.equal("arweave");
    expect(payment_provider).to.equal("stripe");
    expect(chargeback_receipt_date).to.exist;
    expect(chargeback_receipt_id).to.exist;
    expect(payment_receipt_id).to.equal(disputeEventPaymentReceiptId);
    expect(winston_credit_amount).to.equal("50");
    expect(chargeback_reason).to.equal("fraudulent");

    const user = await paymentDatabase["knexReader"]<UserDBResult>(
      tableNames.user
    ).where({
      user_address: disputeEventUserAddress,
    });

    expect(user[0].winston_credit_balance).to.equal("950");

    eventStub.restore();
    paymentIntentResponseStub.restore();
  });

  it("POST /stripe-webhook returns 200 for valid stripe payment success event", async () => {
    const paymentReceivedEventId = "A Payment Receipt Id";
    const paymentReceivedUserAddress = "User Address credited payment";
    const paymentSuccessTopUpQuoteId = "0x0987654321";

    await dbTestHelper.insertStubUser({
      user_address: paymentReceivedUserAddress,
      winston_credit_balance: "0",
    });

    await dbTestHelper.insertStubTopUpQuote({
      top_up_quote_id: paymentSuccessTopUpQuoteId,
      winston_credit_amount: "500",
      payment_amount: "100",
      destination_address: paymentReceivedUserAddress,
    });

    const successStub = paymentIntentStub({
      id: paymentReceivedEventId,
      metadata: {
        topUpQuoteId: paymentSuccessTopUpQuoteId,
      },
      amount: 100,
      currency: "usd",
    });

    const stubEvent = stripeStubEvent({
      type: "payment_intent.succeeded",
      eventObject: successStub,
    });

    const webhookStub = stub(stripe.webhooks, "constructEvent").returns(
      stubEvent
    );

    const { status, statusText, data } = await axios.post(`/v1/stripe-webhook`);

    expect(status).to.equal(200);
    expect(statusText).to.equal("OK");
    expect(data).to.equal("OK");

    // wait a few seconds for the database to update since we return the response right away
    await new Promise((resolve) => setTimeout(resolve, 500));

    const paymentReceipt = await paymentDatabase[
      "knexReader"
    ]<PaymentReceiptDBResult>(tableNames.paymentReceipt).where({
      top_up_quote_id: paymentSuccessTopUpQuoteId,
    });
    expect(paymentReceipt.length).to.equal(1);

    const {
      payment_amount,
      currency_type,
      destination_address,
      destination_address_type,
      payment_provider,
    } = paymentReceipt[0];

    expect(payment_amount).to.equal("100");
    expect(currency_type).to.equal("usd");
    expect(destination_address).to.equal(paymentReceivedUserAddress);
    expect(destination_address_type).to.equal("arweave");
    expect(payment_provider).to.equal("stripe");

    webhookStub.restore();
  });

  it("POST /stripe-webhook returns 400 for invalid stripe requests", async () => {
    stub(stripe.webhooks, "constructEvent").throws(Error("bad"));

    const { status, statusText, data } = await axios.post(`/v1/stripe-webhook`);

    expect(status).to.equal(400);
    expect(statusText).to.equal("Bad Request");
    expect(data).to.equal("Webhook Error!");
  });
});

describe("Caching behavior tests", () => {
  let server: Server;

  const coinGeckoOracle = new CoingeckoArweaveToFiatOracle();
  const arweaveToFiatOracle = new ReadThroughArweaveToFiatOracle({
    oracle: coinGeckoOracle,
  });
  const pricingService = new TurboPricingService({ arweaveToFiatOracle });

  function closeServer() {
    server.close();
    logger.info("Server closed!");
  }

  before(async () => {
    server = await createServer({ pricingService, stripe });
  });

  after(() => {
    closeServer();
  });

  it("GET /price/:currency/:value only calls the oracle once for many subsequent price calls", async () => {
    const coinGeckoStub = stub(
      coinGeckoOracle,
      "getFiatPricesForOneAR"
    ).resolves(expectedArPrices.arweave);

    const pricingSpy = spy(pricingService, "getWCForPayment");

    // Get ten USD prices concurrently
    await Promise.all([
      axios.get(`/v1/price/USD/1000`),
      axios.get(`/v1/price/USD/10000`),
      axios.get(`/v1/price/USD/100000`),
      axios.get(`/v1/price/USD/1000000`),
      axios.get(`/v1/price/USD/500000`),
      axios.get(`/v1/price/USD/250000`),
      axios.get(`/v1/price/USD/125000`),
      axios.get(`/v1/price/USD/62500`),
      axios.get(`/v1/price/USD/31250`),
      axios.get(`/v1/price/USD/15625`),
    ]);

    // Get maximum price for each supported currency concurrently
    await Promise.all(
      supportedPaymentCurrencyTypes.map((currencyType) =>
        axios.get(
          `/v1/price/${currencyType}/${paymentAmountLimits[currencyType].maximumPaymentAmount}`
        )
      )
    );

    // Get minimum price for each supported currency concurrently
    await Promise.all(
      supportedPaymentCurrencyTypes.map((currencyType) =>
        axios.get(
          `/v1/price/${currencyType}/${paymentAmountLimits[currencyType].minimumPaymentAmount}`
        )
      )
    );

    // We expect the pricing service spy to be called 10 times and twice for each supported currencies
    expect(pricingSpy.callCount).to.equal(
      10 + supportedPaymentCurrencyTypes.length * 2
    );

    // But the CoinGecko oracle is only called the one time
    expect(coinGeckoStub.calledOnce).to.be.true;
  });
});
