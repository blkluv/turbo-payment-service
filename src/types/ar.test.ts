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
import { expect } from "chai";

import { AR } from "./ar";

describe("AR class", () => {
  describe("from function", () => {
    it("constructs AR without error when provided with positive decimal numbers with less than 13 decimal places", () => {
      expect(() => AR.from(0)).to.not.throw(Error);
      expect(() => AR.from(0.1)).to.not.throw(Error);
      expect(() => AR.from(1.123456789012)).to.not.throw(Error);
      expect(() => AR.from(Number.MAX_SAFE_INTEGER)).to.not.throw(Error);
    });

    // Not concerned with other number notations for now, e.g. scientific notation
    it("constructs AR without error when provided with positive decimal strings with less than 13 decimal places", () => {
      expect(() => AR.from("0")).to.not.throw(Error);
      expect(() => AR.from("0.1")).to.not.throw(Error);
      expect(() => AR.from("1.123456789012")).to.not.throw(Error);
      expect(() => AR.from("18014398509481982")).to.not.throw(Error);
      expect(() => AR.from("18014398509481982.123456789012")).to.not.throw(
        Error
      );
    });

    it("constructs AR without error when provided with with negative decimal strings with less than 13 decimal places", () => {
      expect(() => AR.from("-0.1")).to.not.throw(Error);
      expect(() => AR.from("-18014398509481982.123456789012")).to.not.throw(
        Error
      );
    });

    it("throws an error when provided with positive decimal numbers or strings with more than 13 decimal places", () => {
      expect(() => AR.from(1.1234567890123)).to.throw(Error);
      expect(() => AR.from("1.1234567890123")).to.throw(Error);
      expect(() => AR.from("18014398509481982.1234567890123")).to.throw(Error);
    });

    it("throws an error when provided with a non-number string", () => {
      expect(() => AR.from("abc")).to.throw(Error);
      expect(() => AR.from("!!!")).to.throw(Error);
      expect(() => AR.from("-")).to.throw(Error);
      expect(() => AR.from("+")).to.throw(Error);
    });
  });

  describe("toString function", () => {
    it("returns the AR value as a BigNumber string", () => {
      expect(AR.from(0).toString()).to.equal("0");
      expect(AR.from("18014398509481982").toString()).to.equal(
        "18014398509481982"
      );
      expect(AR.from("18014398509481982.123456789012").toString()).to.equal(
        "18014398509481982.123456789012"
      );
    });
  });

  describe("valueOf function", () => {
    it("returns the AR value as a BigNumber string", () => {
      expect(AR.from(0).valueOf()).to.equal("0");
      expect(AR.from("18014398509481982").valueOf()).to.equal(
        "18014398509481982"
      );
      expect(AR.from("18014398509481982.123456789012").valueOf()).to.equal(
        "18014398509481982.123456789012"
      );
      expect(AR.from("-18014398509481982.123456789012").valueOf()).to.equal(
        "-18014398509481982.123456789012"
      );
    });
  });

  describe("toWinston function", () => {
    it("returns the Winston value as a BigNumber string", () => {
      expect(
        AR.from("18014398509481982.123456789012").toWinston().toString()
      ).to.equal("18014398509481982123456789012");
      expect(
        AR.from("-18014398509481982.123456789012").toWinston().toString()
      ).to.equal("-18014398509481982123456789012");
    });
  });
});
