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
import { describe, it } from "mocha";

import { ReadThroughPromiseCache } from "./readThroughPromiseCache";

describe("ReadThroughPromiseCache Class", () => {
  it("should be able to cache and retrieve new entries", async () => {
    // Test function to make sure we return a different value after the first call
    // Since function is passed in the constructor

    let testTracker = 0;

    const testFunction = async () => {
      if (testTracker < 1) {
        testTracker++;
        return "one";
      } else {
        return "two";
      }
    };
    const cache = new ReadThroughPromiseCache<string, string>({
      cacheParams: { cacheCapacity: 10 },
      readThroughFunction: testFunction,
    });

    expect(await cache.get("1")).to.equal("one");
    expect(await cache.get("1")).to.equal("one");
  });

  it("should throw error if readthrough function throws", async () => {
    let testTracker = 0;

    const testFunction = async () => {
      if (testTracker < 1) {
        testTracker++;
        throw new Error("test error");
      } else {
        return "two";
      }
    };
    const cache = new ReadThroughPromiseCache<string, string>({
      cacheParams: { cacheCapacity: 10 },
      readThroughFunction: testFunction,
    });
    try {
      await cache.get("1");
      expect.fail("Error: test error");
    } catch (error) {
      expect(error).to.exist;
    }
    expect(await cache.get("1")).to.equal("two");
  });

  it("should purge all entries after ttl expires", async () => {
    // Test function to make sure we return a different value after the first call
    // Since function is passed in the constructor

    let testTracker = 0;

    const testFunction = async () => {
      if (testTracker < 1) {
        testTracker++;
        return "one";
      } else {
        return "two";
      }
    };

    const cache = new ReadThroughPromiseCache<string, string>({
      cacheParams: { cacheCapacity: 10, cacheTTL: 5 },
      readThroughFunction: testFunction,
    });

    expect(await cache.get("1")).to.equal("one");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cache.get("1")).to.equal("two");
  });

  it("preserves most requested entries when over capacity", async () => {
    // Test function to make sure we return a different value after the first call
    // Since function is passed in the constructor
    let testTracker = 0;

    const testFunction = async () => {
      if (testTracker < 1) {
        testTracker++;
        return "one";
      } else {
        return "two";
      }
    };

    const cache = new ReadThroughPromiseCache<string, string>({
      cacheParams: { cacheCapacity: 1, cacheTTL: 5 },
      readThroughFunction: testFunction,
    });

    expect(await cache.get("1")).to.equal("one");
    expect(await cache.get("1")).to.equal("one");
    expect(await cache.get("2")).to.equal("two");
    expect(await cache.get("1")).to.equal("two");
  });
});
