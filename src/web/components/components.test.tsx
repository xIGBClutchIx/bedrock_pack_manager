// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { AppStateResponse } from "../../shared/api";
import { TEST_SERVER, type PackRow, type WorldStatus } from "../../shared/model";
import { AppProvider } from "../state/app";
import { ConnectScreen } from "./ConnectScreen";
import { PacksTab } from "./PacksTab";
import { WorldTab } from "./WorldTab";

const row = (overrides: Partial<PackRow>): PackRow => ({
  key: "",
  kind: "bp",
  uuid: "x",
  version: [1, 0, 0],
  versionLabel: "1.0.0",
  name: "Pack",
  status: "ok",
  registered: true,
  paths: [],
  path: null,
  onServerVersions: ["1.0.0"],
  scope: "shared",
  dependencies: [],
  order: null,
  newerOnServer: null,
  usedBy: [],
  description: "",
  authors: [],
  minEngineVersion: null,
  subpacks: [],
  subpack: null,
  ...overrides,
});

const status: WorldStatus = {
  world: "worlds/W",
  worldName: "W",
  isLevelName: false,
  packs: [
    row({
      key: "bp:a:1.0.0",
      uuid: "a",
      name: "Alpha",
      paths: ["/bp/Alpha"],
      path: "bp/Alpha",
      order: 0,
      newerOnServer: [1, 1, 0],
      description: "Adds alpha things",
      dependencies: [
        {
          uuid: "d",
          moduleName: null,
          versionLabel: "1.0.0",
          name: "Delta",
          state: "inactive",
          kind: "bp",
          serverVersion: [1, 0, 0],
          tooOld: false,
        },
      ],
      usedBy: [{ world: "Other", versionLabel: "1.0.0" }],
    }),
    row({
      key: "bp:b:2.0.0",
      uuid: "b",
      version: [2, 0, 0],
      versionLabel: "2.0.0",
      name: "Beta",
      status: "version-mismatch",
      paths: ["/bp/Beta"],
      path: "bp/Beta",
      order: 1,
    }),
    row({ key: "bp:m:1.0.0", uuid: "m", name: "Missing One", status: "missing", onServerVersions: [], scope: null, order: 2 }),
    row({
      kind: "rp",
      uuid: "c",
      name: "Gamma",
      status: "unregistered",
      registered: false,
      paths: ["/rp/Gamma"],
      path: "rp/Gamma",
      scope: "world",
    }),
  ],
  problems: [
    { kind: "nested", message: "/bp/Wrap/Inner is nested one folder too deep", path: "bp/Wrap/Inner", fixable: true },
    { kind: "partial", message: "/bp/half has no manifest.json", path: "bp/half" },
  ],
  notes: [],
  hiddenBuiltin: 3,
  level: {
    exists: true,
    beta: false,
    gamemode: "survival",
    levelName: "W",
    error: null,
    experiments: [
      { key: "gametest", label: "Beta APIs", description: "Script betas", enabled: false },
      { key: "some_toggle", label: "some_toggle", description: "Set in this world's level.dat", enabled: true },
    ],
  },
  installDirs: { bp: "/bp", rp: "/rp" },
};

const ctx = { world: "worlds/W", status, setStatus: () => undefined, reload: async () => undefined };
const renderPacks = () =>
  render(
    <AppProvider>
      <PacksTab ctx={ctx} />
    </AppProvider>,
  );
const bodyRows = () => screen.getAllByRole("row").slice(1);

describe("PacksTab", () => {
  it("lists packs with statuses and filters by chip and search", () => {
    renderPacks();
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByText("Server has 1.0.0")).toBeInTheDocument();
    expect(screen.getByText("Gamma (in world)")).toBeInTheDocument();
    expect(screen.getByText("Not on the server")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Not registered/ }));
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]!).getByText("Gamma", { selector: ".name-line" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Update available/ }));
    expect(bodyRows()).toHaveLength(1);
    expect(within(bodyRows()[0]!).getByText("Alpha", { selector: ".name-line" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: "alpha things" } });
    expect(bodyRows()).toHaveLength(1);
  });

  it("shows problems with a fix button only where the app can fix them", () => {
    renderPacks();
    expect(screen.getByText("2 things need attention")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fix" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /need attention/ }));
    expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
  });

  it("offers the action each row needs, and the load order in details", () => {
    renderPacks();
    const [alpha, beta, missing, gamma] = bodyRows();
    expect(within(alpha!).getByRole("button", { name: "Use v1.1.0" })).toBeInTheDocument();
    expect(within(beta!).getByRole("button", { name: "Use v1.0.0" })).toBeInTheDocument();
    expect(within(missing!).getByRole("button", { name: "Drop entry" })).toBeInTheDocument();
    expect(within(gamma!).getByRole("button", { name: "Add to world" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details for Alpha" }));
    expect(screen.getByRole("button", { name: "Move Alpha up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Alpha down" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Details for Missing One" }));
    expect(screen.getByRole("button", { name: "Move Missing One down" })).toBeDisabled();
  });

  it("shows details: description, dependencies and other worlds", () => {
    renderPacks();
    fireEvent.click(screen.getByRole("button", { name: "Details for Alpha" }));
    expect(screen.getByText("Adds alpha things")).toBeInTheDocument();
    expect(screen.getByText("On the server, not active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activate 1 dependency" })).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
  });

  it("selects registered and unregistered packs with the right actions for each", () => {
    renderPacks();
    expect(screen.queryByText(/selected/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    expect(screen.getByText("1 pack selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall & delete files" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete folder/ })).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Gamma" }));
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("4 packs selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });
});

describe("WorldTab", () => {
  it("lists experiments, including unknown ones the world has, and enables save on a change", () => {
    render(
      <AppProvider>
        <WorldTab ctx={ctx} />
      </AppProvider>,
    );
    const save = screen.getByRole("button", { name: "Save world settings" });
    expect(save).toBeDisabled();
    expect(screen.getByRole("switch", { name: "some_toggle" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Beta APIs" }));
    expect(save).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Beta APIs" }));
    expect(save).toBeDisabled();
  });
});

describe("ConnectScreen", () => {
  it("shows host fields for remote protocols and a folder field for this PC", () => {
    render(
      <AppProvider>
        <ConnectScreen />
      </AppProvider>,
    );
    expect(screen.getByText("No saved servers yet. Servers you connect to are saved here.")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toBeInTheDocument();
    expect(screen.getByLabelText("Port")).toHaveAttribute("placeholder", "22");
    fireEvent.click(screen.getByLabelText(/Implicit FTPS/));
    expect(screen.getByLabelText("Port")).toHaveAttribute("placeholder", "990");
    fireEvent.click(screen.getByLabelText(/This PC/));
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.getByLabelText("Server folder on this computer")).toBeInTheDocument();
    expect(screen.queryByLabelText("Test server")).toBeNull();
  });

  it("offers the demo server in one click when the app runs with --test-server", () => {
    const state: AppStateResponse = {
      connected: false,
      label: null,
      settings: null,
      layout: null,
      overrides: { packScope: "shared" },
      worlds: [],
      defaultWorld: null,
      activeJob: null,
      uploads: [],
      profiles: [],
      testServer: true,
    };
    render(
      <AppProvider initialState={state}>
        <ConnectScreen />
      </AppProvider>,
    );
    fireEvent.click(screen.getByLabelText("Test server"));
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByLabelText("Server name")).toBeNull();
    expect(screen.getByText(`${TEST_SERVER.host}:${TEST_SERVER.sftpPort}, user ${TEST_SERVER.username}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "FTP" }));
    expect(screen.getByText(`${TEST_SERVER.host}:${TEST_SERVER.ftpPort}, user ${TEST_SERVER.username}`)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("SFTP"));
    expect(screen.getByLabelText("Host")).toBeInTheDocument();
  });
});
