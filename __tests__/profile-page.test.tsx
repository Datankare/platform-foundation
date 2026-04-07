/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ProfilePage from "@/components/auth/ProfilePage";
import type { UserProfile } from "@/platform/auth/profile";

const mockProfile: UserProfile = {
  id: "user-1",
  email: "test@example.com",
  displayName: "TestUser",
  avatarUrl: null,
  realName: null,
  languagePreference: "en",
  timezone: "UTC",
  profileVisibility: "private",
  displayNameVisibility: "public",
  avatarVisibility: "private",
  languageVisibility: "friends",
  timezoneVisibility: "private",
  emailOptIn: false,
  pushNotificationsEnabled: true,
  mfaEnabled: true,
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00Z",
  lastLoginAt: "2026-03-30T12:00:00Z",
};

const mockProps = {
  onLoadProfile: jest.fn().mockResolvedValue(mockProfile),
  onUpdateProfile: jest.fn().mockResolvedValue({ success: true }),
  onSignOut: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockProps.onLoadProfile.mockResolvedValue(mockProfile);
  mockProps.onUpdateProfile.mockResolvedValue({ success: true });
});

describe("ProfilePage", () => {
  it("shows loading state initially", () => {
    mockProps.onLoadProfile.mockReturnValue(new Promise(() => {}));
    render(<ProfilePage {...mockProps} />);
    expect(screen.getByText("Loading profile...")).toBeDefined();
  });

  it("loads and displays profile data", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("test@example.com")).toBeDefined();
    });
    expect(screen.getByText("Verified")).toBeDefined();
    expect(screen.getByText("MFA Enabled")).toBeDefined();
  });

  it("shows profile not found when load returns null", async () => {
    mockProps.onLoadProfile.mockResolvedValue(null);
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Profile not found.")).toBeDefined();
    });
  });

  it("populates form fields from profile", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      const input = screen.getByLabelText("Display Name") as HTMLInputElement;
      expect(input.value).toBe("TestUser");
    });
  });

  it("calls onUpdateProfile on save", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Save Changes"));
    });

    await waitFor(() => {
      expect(mockProps.onUpdateProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "TestUser",
          languagePreference: "en",
        })
      );
    });
  });

  it("shows success message after save", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Save Changes"));
    });

    await waitFor(() => {
      expect(screen.getByText("Profile updated successfully.")).toBeDefined();
    });
  });

  it("shows error message on save failure", async () => {
    mockProps.onUpdateProfile.mockResolvedValue({
      success: false,
      error: "Network error",
    });
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Save Changes")).toBeDefined();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Save Changes"));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Network error");
    });
  });

  it("calls onSignOut when sign out clicked", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Sign Out")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Sign Out"));
    expect(mockProps.onSignOut).toHaveBeenCalled();
  });

  it("renders visibility selects", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      const selects = screen.getAllByRole("combobox");
      expect(selects.length).toBeGreaterThanOrEqual(5);
    });
  });

  it("renders communication checkboxes", async () => {
    render(<ProfilePage {...mockProps} />);
    await waitFor(() => {
      expect(screen.getByText("Email notifications")).toBeDefined();
      expect(screen.getByText("Push notifications")).toBeDefined();
    });
  });
});
