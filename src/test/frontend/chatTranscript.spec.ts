import { expect, test } from "@playwright/test";

test("renders markdown transcript content and branches a chat", async ({ page, request }) => {
  const chatTitle = `Renderer ${crypto.randomUUID().slice(0, 8)}`;
  const createChatResponse = await request.post("/api/chats", {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    json: {
      title: chatTitle,
    },
  });

  expect(createChatResponse.ok()).toBe(true);

  const createChatPayload = (await createChatResponse.json()) as {
    chat: {
      id: string;
    };
  };
  const appendMessageResponse = await request.post(
    `/api/chats/${createChatPayload.chat.id}/messages`,
    {
      headers: {
        Origin: "http://127.0.0.1:3000",
      },
      json: {
        content: [
          "# Render Check",
          "",
          "Inline math $a^2 + b^2 = c^2$.",
          "",
          "```ts",
          "console.log('hello from code');",
          "```",
          "",
          "```mermaid",
          "graph TD",
          "  Start --> Finish",
          "```",
        ].join("\n"),
        role: "assistant",
      },
    },
  );

  expect(appendMessageResponse.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: `Open chat: ${chatTitle}` }).click();

  await expect(page.getByText("Render Check")).toBeVisible();
  await expect(page.locator(".message-markdown .katex").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code" }).first()).toBeVisible();
  await expect(page.locator(".mermaid-diagram-viewer")).toBeVisible();

  await page
    .locator('[data-slot="card"]')
    .filter({ hasText: "Render Check" })
    .getByRole("button", { name: "Branch" })
    .click();

  await expect(
    page.getByRole("button", {
      name: `Open chat: ${chatTitle} (branch)`,
    }),
  ).toBeVisible();
});

test("serves persisted image and audio attachments from transcript media URLs", async ({
  page,
  request,
}) => {
  const chatTitle = `Media ${crypto.randomUUID().slice(0, 8)}`;
  const createChatResponse = await request.post("/api/chats", {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    json: {
      title: chatTitle,
    },
  });

  expect(createChatResponse.ok()).toBe(true);

  const createChatPayload = (await createChatResponse.json()) as {
    chat: {
      id: string;
    };
  };
  const chatId = createChatPayload.chat.id;
  const imageUploadResponse = await request.post("/api/media/upload", {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    multipart: {
      chatId,
      files: {
        buffer: Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
          0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5,
          0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc,
          0xff, 0x1f, 0x00, 0x03, 0x03, 0x02, 0x00, 0xef, 0xef, 0xf9, 0x7a, 0x00, 0x00, 0x00, 0x00,
          0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]),
        mimeType: "image/png",
        name: "pixel.png",
      },
      messageIndex: "0",
    },
  });

  expect(imageUploadResponse.ok()).toBe(true);

  const imageUploadPayload = (await imageUploadResponse.json()) as {
    attachments: Array<{ id: string }>;
  };

  const audioUploadResponse = await request.post("/api/media/upload", {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    multipart: {
      chatId,
      files: {
        buffer: Buffer.from([
          0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74,
          0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e,
          0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00,
          0x00,
        ]),
        mimeType: "audio/wav",
        name: "tone.wav",
      },
      messageIndex: "1",
    },
  });

  expect(audioUploadResponse.ok()).toBe(true);

  const audioUploadPayload = (await audioUploadResponse.json()) as {
    attachments: Array<{ id: string }>;
  };
  const appendImageMessageResponse = await request.post(`/api/chats/${chatId}/messages`, {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    json: {
      content: "Image playback check",
      mediaAttachments: imageUploadPayload.attachments,
      role: "user",
    },
  });

  expect(appendImageMessageResponse.ok()).toBe(true);

  const appendAudioMessageResponse = await request.post(`/api/chats/${chatId}/messages`, {
    headers: {
      Origin: "http://127.0.0.1:3000",
    },
    json: {
      content: "Audio playback check",
      mediaAttachments: audioUploadPayload.attachments,
      role: "user",
    },
  });

  expect(appendAudioMessageResponse.ok()).toBe(true);

  await page.goto("/");
  await page.getByRole("button", { name: `Open chat: ${chatTitle}` }).click();

  const image = page.locator("img[alt='pixel.png']");
  const audio = page.locator("audio").first();

  await expect(image).toBeVisible();
  await expect(audio).toBeVisible();

  const imageSrc = await image.getAttribute("src");
  const audioSrc = await audio.getAttribute("src");

  expect(imageSrc).toContain("/api/chats/");
  expect(audioSrc).toContain("/api/chats/");

  const [imageResponse, audioHeadResponse] = await Promise.all([
    request.get(imageSrc ?? ""),
    request.fetch(audioSrc ?? "", { method: "HEAD" }),
  ]);

  expect(imageResponse.ok()).toBe(true);
  expect(audioHeadResponse.ok()).toBe(true);
});
