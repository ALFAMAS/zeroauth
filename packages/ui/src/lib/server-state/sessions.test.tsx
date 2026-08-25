import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SessionsClient from "@/app/admin/sessions/SessionsClient";
import UserSessionsPage from "@/app/dashboard/sessions/page";
import {
  USER_SESSIONS_PATH,
  buildAdminSessionRevokePath,
  buildAdminSessionsListPath,
  sessionKeys,
  userSessionKeys,
} from "./sessions";
import { mockApiDelete, mockApiGet } from "@/test/apiClientMock";

const session = {
  id: "sess_1",
  userId: "user_1",
  userEmail: "user@example.com",
  isActive: true,
  createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  // isActiveSession() (columns.tsx) hides the Revoke action once expiresAt is
  // in the past, so this must stay relative to "now" rather than a fixed date.
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });

  const result = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...result, queryClient };
}

describe("sessions TanStack Query server state", () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiDelete.mockReset();
  });

  it("models sessions domain query keys and paths", () => {
    expect(sessionKeys.list({ page: 1, limit: 20 })).toEqual([
      "admin",
      "sessions",
      "list",
      { page: 1, limit: 20 },
    ]);
    expect(buildAdminSessionsListPath({ page: 1, limit: 20 })).toBe(
      "/admin/sessions?page=1&limit=20"
    );
    expect(buildAdminSessionRevokePath("sess_1")).toBe("/admin/sessions/sess_1");
  });

  it("renders paginated sessions through apiClient/TanStack Query, not legacy api", async () => {
    mockApiGet.mockResolvedValue({
      data: [session],
      pagination: { total: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });

    renderWithQueryClient(<SessionsClient />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(await screen.findByText("user@example.com")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith("/admin/sessions?page=1&limit=20");
  });

  it("renders error + retry when the sessions list fails", async () => {
    mockApiGet.mockRejectedValueOnce(new Error("sessions unavailable"));
    renderWithQueryClient(<SessionsClient />);

    expect(await screen.findByText("sessions unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("revokes a session via mutation and invalidates the list", async () => {
    mockApiGet.mockResolvedValue({
      data: [session],
      pagination: { total: 1, totalPages: 1, hasNext: false, hasPrev: false },
    });
    mockApiDelete.mockResolvedValue({ success: true });

    const user = userEvent.setup();
    const { queryClient } = renderWithQueryClient(<SessionsClient />);
    await screen.findByText("user@example.com");

    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() =>
      expect(mockApiDelete).toHaveBeenCalledWith("/admin/sessions/sess_1")
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sessionKeys.list() });
  });

  it("renders user dashboard sessions through apiClient/TanStack Query", async () => {
    mockApiGet.mockResolvedValue([
      {
        id: "sess_user_1",
        ipAddress: "203.0.113.1",
        isActive: true,
        isCurrent: true,
        lastActivityAt: "2026-07-03T00:00:00Z",
      },
    ]);

    renderWithQueryClient(<UserSessionsPage />);

    expect(await screen.findByText("Active Sessions")).toBeInTheDocument();
    expect(mockApiGet).toHaveBeenCalledWith(USER_SESSIONS_PATH);
    expect(userSessionKeys.list()).toEqual(["sessions", "list"]);
  });
});
