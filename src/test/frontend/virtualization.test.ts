import { describe, expect, test } from "bun:test";
import { createMeasuredHeightsStore, pruneMeasuredHeights } from "../../lib/virtualization";

describe("virtualization measurement cache pruning", () => {
  test("returns the same cache when all measured ids are still active", () => {
    const measuredHeights = {
      alpha: 120,
      beta: 180,
    };

    expect(pruneMeasuredHeights(measuredHeights, ["alpha", "beta", "gamma"])).toBe(measuredHeights);
  });

  test("drops stale measurements while preserving active ones", () => {
    expect(
      pruneMeasuredHeights(
        {
          alpha: 120,
          beta: 180,
          stale: 240,
        },
        ["beta", "alpha"],
      ),
    ).toEqual({
      alpha: 120,
      beta: 180,
    });
  });

  test("empties the cache when no active ids remain", () => {
    expect(
      pruneMeasuredHeights(
        {
          alpha: 120,
        },
        [],
      ),
    ).toEqual({});
  });

  test("measured heights store prunes stale ids before recording the next measurement", () => {
    const store = createMeasuredHeightsStore({
      active: 120,
      stale: 180,
    });

    store.setMeasuredHeight("active", 144, ["active"]);

    expect(store.getSnapshot()).toEqual({
      active: 144,
    });
  });

  test("measured heights store can explicitly drop stale measurements", () => {
    const store = createMeasuredHeightsStore({
      active: 120,
      stale: 180,
    });

    store.prune(["active"]);

    expect(store.getSnapshot()).toEqual({
      active: 120,
    });
  });
});
