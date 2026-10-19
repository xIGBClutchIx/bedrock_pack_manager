// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { WorldStatus } from "../../shared/model";
import { AppProvider } from "../state/app";
import { ConnectScreen } from "./ConnectScreen";
import { PacksTab } from "./PacksTab";

const status: WorldStatus = {
  world: "worlds/W",
  worldName: "W",
  packs: [
    {
      key: "bp:a:1.0.0",
      kind: "bp",
      uuid: "a",
      version: [1, 0, 0],
      versionLabel: "1.0.0",
      name: "Alpha",
      status: "ok",
      registered: true,
      paths: ["/bp/Alpha"],
      onServerVersions: ["1.0.0"],
      scope: "shared",
      dependencies: [],
    },
    {
      key: "bp:b:2.0.0",
      kind: "bp",
      uuid: "b",
      version: [2, 0, 0],
      versionLabel: "2.0.0",
      name: "Beta",
      status: "version-mismatch",
      registered: true,
      paths: ["/bp/Beta"],
      onServerVersions: ["1.0.0"],
      scope: "shared",
      dependencies: [],
    },
    {
      key: "",
      kind: "rp",
      uuid: "c",
      version: [1, 0, 0],
      versionLabel: "1.0.0",
      name: "Gamma",
      status: "unregistered",
      registered: false,
      paths: ["/rp/Gamma"],
      onServerVersions: ["1.0.0"],
      scope: "world",
      dependencies: [],
    },
  ],
  problems: [
    { kind: "nested", message: "/bp/Wrap/Inner is nested one folder too deep", path: "bp/Wrap/Inner", fixable: true },
    { kind: "partial", message: "/bp/half has no manifest.json", path: "bp/half" },
  ],
  notes: [],
  hiddenBuiltin: 3,
  level: { exists: true, beta: false, gamemode: "survival", levelName: "W", error: null },
  installDirs: { bp: "/bp", rp: "/rp" },
};

const renderPacks = () =>
  render(
    <AppProvider>
      <PacksTab ctx={{ world: "worlds/W", status, setStatus: () => undefined, reload: async () => undefined }} />
    </AppProvider>,
  );

describe("PacksTab", () => {
  it("lists packs with statuses and filters by chip and search", () => {
    renderPacks();
    const rows = () => screen.getAllByRole("row").slice(1);
    expect(rows()).toHaveLength(3);
    expect(screen.getByText("server has 1.0.0")).toBeInTheDocument();
    expect(screen.getByText("(in world)")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Not registered/ }));
    expect(rows()).toHaveLength(1);
    expect(within(rows()[0]!).getByText("Gamma")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: "beta" } });
    expect(rows()).toHaveLength(1);
  });

  it("shows problems with a fix button only where the app can fix them", () => {
    renderPacks();
    expect(screen.getByText("2 things to look at.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fix" })).toHaveLength(1);
  });

  it("selects registered packs and shows the uninstall bar", () => {
    renderPacks();
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.getByText("1 pack selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("2 packs selected")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select Gamma" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

describe("ConnectScreen", () => {
  it("shows host fields for remote protocols and a folder field for this PC", () => {
    render(
      <AppProvider>
        <ConnectScreen />
      </AppProvider>,
    );
    expect(screen.getByText("No saved servers yet. Connect once with “Save as a server” ticked.")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toBeInTheDocument();
    expect(screen.getByLabelText("Port")).toHaveAttribute("placeholder", "22");
    fireEvent.click(screen.getByLabelText(/FTPS implicit/));
    expect(screen.getByLabelText("Port")).toHaveAttribute("placeholder", "990");
    fireEvent.click(screen.getByLabelText(/This PC/));
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.getByLabelText("Server folder on this computer")).toBeInTheDocument();
  });
});
