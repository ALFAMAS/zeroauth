import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/commandPalette";
import { CommandPalette } from "./CommandPalette";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("CommandPalette", () => {
  it("labels the search combobox so it can be found and filled", async () => {
    render(<CommandPalette />);
    document.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));

    // cmdk labels its <input> via a hidden <label> referenced through
    // aria-labelledby, which wins over any aria-label passed directly to
    // the input — so the accessible name must come from CommandDialog's
    // inputLabel prop, not from CommandInput's own props.
    const search = await screen.findByRole("dialog", { name: "Command palette" });
    const combobox = within(search).getByRole("combobox", { name: "Search" });

    await userEvent.type(combobox, "profile");
    expect(await screen.findByRole("option", { name: /^Profile/i })).toBeVisible();
  });

  it("navigates to the selected destination", async () => {
    render(<CommandPalette />);
    document.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));

    const combobox = await screen.findByRole("combobox", { name: "Search" });
    await userEvent.type(combobox, "profile");
    await userEvent.click(await screen.findByRole("option", { name: /^Profile/i }));

    expect(push).toHaveBeenCalledWith("/dashboard/profile");
  });
});
