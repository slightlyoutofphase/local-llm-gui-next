import { expect, test } from "bun:test";
import { initializeClientStores } from "../../components/Providers";

test("initializeClientStores hydrates models before chats and opens streams afterward", async () => {
  const callOrder: string[] = [];

  await initializeClientStores({
    connectDebugStream: () => {
      callOrder.push("connectDebugStream");
    },
    connectRuntimeStream: () => {
      callOrder.push("connectRuntimeStream");
    },
    hydrateChats: async () => {
      callOrder.push("hydrateChats");
    },
    hydrateModels: async () => {
      callOrder.push("hydrateModels");
    },
  });

  expect(callOrder).toEqual([
    "hydrateModels",
    "hydrateChats",
    "connectRuntimeStream",
    "connectDebugStream",
  ]);
});
