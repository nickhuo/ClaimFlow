import { expect, test, type Page } from "@playwright/test";

async function showProgress(page: Page, open: boolean) {
  const toggle = page.getByRole("button", {
    name: /Details & help|CONVERSATION UPDATE.*Close|STEP.*Close/,
  });
  if (await toggle.isVisible()) {
    if ((await toggle.getAttribute("aria-expanded")) !== String(open)) await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", String(open));
  }
}

test("React conversation completes four phases, recovers email failure and resets with accessible dialogs", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A clear next step." })).toBeVisible();
  await page.screenshot({ path: `artifacts/ui-${info.project.name}-welcome.png`, fullPage: true });
  await page.getByRole("button", { name: "Try a sample conversation" }).click();
  await expect(page.getByRole("textbox", { name: "Your message" })).toBeFocused();
  await page.getByRole("textbox", { name: "Your message" }).press("Enter");
  await expect(page.getByRole("button", { name: "Finish & review summary" })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("pathology report");
  await showProgress(page, true);
  await expect(page.getByRole("listitem").filter({ hasText: "Work through it" })).toHaveAttribute(
    "aria-current",
    "step",
  );
  await showProgress(page, false);
  await page.getByRole("button", { name: "Finish & review summary" }).click();
  await page.getByRole("button", { name: "Save to demo outbox" }).click();
  await expect(page.getByRole("button", { name: "Retry email", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry email", exact: true }).click();
  await expect(
    page.getByText("Recorded in demo outbox · no email sent", { exact: true }),
  ).toBeVisible();
  await showProgress(page, true);
  await page.getByRole("button", { name: "View outbox" }).click();
  await expect(page.getByRole("dialog", { name: "Your outbox" })).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("m•••@email.com");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "View outbox" })).toBeFocused();
  await showProgress(page, false);
  await page.getByRole("button", { name: "Ask another question" }).click();
  await page
    .getByRole("textbox", { name: "Your message" })
    .fill("What is the reimbursement amount?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("log")).toContainText("USD 0.00");
  await page.screenshot({
    path: `artifacts/ui-${info.project.name}-conversation.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("button", { name: "Keep this conversation" })).toBeFocused();
  await page.getByRole("button", { name: "Start new", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Let’s make sense of your claim." }),
  ).toBeVisible();
  await expect(page.getByRole("log")).not.toContainText("CL-2048");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("keyboard input, reduced motion, isolated reload and a simulated handoff remain usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Your message" });
  await editor.fill("I'm worried. Why was my claim denied?");
  await editor.press("Shift+Enter");
  await expect(editor).toHaveValue(/\n$/);
  await editor.press("Enter");
  await expect(page.getByRole("log")).toContainText("three different identity details");
  await expect(page.getByRole("log")).not.toContainText("pathology");
  await page.reload();
  await expect(page.getByRole("log")).toBeEmpty();
  await showProgress(page, true);
  await page.getByRole("button", { name: "Request human assistance" }).click();
  await expect(
    page.getByText(
      "Human assistance requested. This demo records the request; a live representative has not been connected.",
    ),
  ).toBeVisible();
  await expect(editor).toBeDisabled();
});

test("editable suggestions, growing drafts, IME input and transcript navigation", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Your message" });
  const initialHeight = await editor.evaluate((element) => element.clientHeight);
  await page.getByRole("button", { name: "Try a sample conversation" }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(/Margaret Chen/);
  await expect(page.getByRole("log")).toBeEmpty();
  await editor.fill("One line\nTwo lines\nThree lines\nFour lines\nFive lines\nSix lines");
  expect(await editor.evaluate((element) => element.clientHeight)).toBeGreaterThan(initialHeight);
  await editor.fill("正在输入");
  await editor.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
  await expect(editor).toHaveValue("正在输入");
  await expect(page.getByRole("log")).toBeEmpty();

  await page.getByRole("button", { name: "Try a sample conversation" }).click();
  await editor.press("Enter");
  await expect(page.getByRole("log")).toContainText("pathology report");
  const followUp = page.getByRole("button", { name: "What is the reimbursement amount?" });
  await followUp.click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue("What is the reimbursement amount?");
  await editor.press("Enter");
  await expect(page.getByRole("log")).toContainText("USD 0.00");

  // Hold a response while the user reads earlier messages. Its arrival must not move them.
  let releaseResponse!: () => void;
  const responseHeld = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route("**/turns", async (route) => {
    const response = await route.fetch();
    await responseHeld;
    await route.fulfill({ response });
  });
  const replyCount = await page.locator(".message.assistant").count();
  await editor.fill("What documents do I need?");
  await editor.press("Enter");
  await expect(page.getByRole("button", { name: "Cancel response" })).toBeVisible();
  await page.locator(".scroll-area").evaluate((element) => {
    element.scrollTop = 0;
  });
  const latest = page.getByRole("button", { name: "Latest messages" });
  await expect(latest).toBeVisible();
  releaseResponse();
  await expect(page.locator(".message.assistant")).toHaveCount(replyCount + 1);
  expect(await page.locator(".scroll-area").evaluate((element) => element.scrollTop)).toBe(0);
  await latest.click();
  await expect(latest).not.toBeVisible();
  expect(
    await page
      .locator(".scroll-area")
      .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
  ).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
