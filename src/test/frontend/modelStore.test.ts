import { expect, test } from "bun:test";
import { createSerialTaskQueue } from "../../store/modelStore";

test("createSerialTaskQueue runs async tasks in FIFO order", async () => {
  const queue = createSerialTaskQueue();
  const events: string[] = [];

  const firstTask = queue.enqueue(async () => {
    events.push("first:start");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
    events.push("first:end");

    return "first";
  });
  const secondTask = queue.enqueue(async () => {
    events.push("second:start");
    events.push("second:end");

    return "second";
  });

  expect(queue.hasPendingTasks()).toBe(true);
  expect(await firstTask).toBe("first");
  expect(await secondTask).toBe("second");
  expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  expect(queue.hasPendingTasks()).toBe(false);
});

test("createSerialTaskQueue keeps later tasks runnable after a failure", async () => {
  const queue = createSerialTaskQueue();
  const events: string[] = [];

  const failingTask = queue.enqueue(async () => {
    events.push("first:start");
    throw new Error("boom");
  });
  const recoveryTask = queue.enqueue(async () => {
    events.push("second:start");

    return "ok";
  });

  await expect(failingTask).rejects.toThrow("boom");
  expect(await recoveryTask).toBe("ok");
  expect(events).toEqual(["first:start", "second:start"]);
  expect(queue.hasPendingTasks()).toBe(false);
});
