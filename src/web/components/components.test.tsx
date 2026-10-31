// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://127.0.0.1:5000/?t=test-token" }
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ROUTES, type AppStateResponse } from "../../shared/api";
import type { JobInfo } from "../../shared/events";
import { TEST_SERVER, type InstallResult, type PackRow, type PlanItem, type UploadEntry, type WorldStatus } from "../../shared/model";
import { App } from "../App";
import { getUploads, uploadFile } from "../api/client";
import type * as ClientModule from "../api/client";
import { AppProvider, useApp } from "../state/app";
import { ConfirmHost, Modal, STALE_LINK_MESSAGE, ToastHost } from "./common";
import { ConnectScreen } from "./ConnectScreen";
import { InstallTab } from "./InstallTab";
import { PacksTab } from "./PacksTab";
import { WorldTab } from "./WorldTab";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientModule>();
  return { ...actual, uploadFile: vi.fn(actual.uploadFile), getUploads: vi.fn(actual.getUploads) };
});

/** EventSource stand-in: the test ends each job by hand. */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {}
  end(result: unknown) {
    const job: JobInfo = { id: "j", kind: "install", title: "", status: "done", startedAt: 0, finishedAt: 0, warnings: [], result };
    act(() => this.onmessage?.({ data: JSON.stringify({ type: "end", seq: 0, job }) }));
  }
}

type FetchHandler = (url: string, init: RequestInit | undefined) => { status?: number; body: unknown } | undefined;
/** Answer fetch calls from `handler`; anything it does not answer is a 404. */
function stubFetch(handler: FetchHandler) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = handler(String(input), init) ?? { status: 404, body: { error: "Not found", code: "not_found" } };
    const status = answer.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => answer.body,
    } as Response;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  FakeEventSource.all = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(uploadFile).mockReset();
  vi.mocked(getUploads).mockReset();
});

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

  it("acts only on selected rows the current filter shows", () => {
    renderPacks();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Gamma" }));
    expect(screen.getByText("2 packs selected")).toBeInTheDocument();

    // Alpha is hidden by the filter: the bar counts and offers actions for Gamma only.
    fireEvent.click(screen.getByRole("button", { name: /Not registered/ }));
    expect(screen.getByText("1 pack selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uninstall & delete files" })).toBeNull();

    // The hidden selection is kept and counts again once it is on screen.
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText("2 packs selected")).toBeInTheDocument();
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

const baseState: AppStateResponse = {
  connected: true,
  label: "sftp://host/",
  settings: null,
  layout: null,
  overrides: { packScope: "shared" },
  worlds: [],
  defaultWorld: null,
  activeJob: null,
  uploads: [],
  profiles: [],
  testServer: false,
};
const upload = (name: string): UploadEntry => ({ name, isDir: false, files: 1, size: 10 });
const planItem = (name: string): PlanItem => ({
  name,
  uuid: name,
  version: [1, 0, 0],
  versionLabel: "1.0.0",
  kind: "bp",
  source: `${name}.mcpack`,
  action: "upload",
  reason: "New pack",
  target: `/bp/${name}`,
  replaces: [],
  keeps: [],
  warnings: [],
});
const planOf = (...names: string[]): InstallResult => ({
  plan: names.map(planItem),
  stats: { installed: 0, skipped: 0, errors: 0 },
  applied: false,
  dryRun: true,
});

describe("InstallTab", () => {
  /** Answers install requests with a new job each time and records their bodies. */
  function stubInstall() {
    const requests: { duplicateMode: string; dryRun: boolean }[] = [];
    stubFetch((url, init) => {
      if (url === ROUTES.install && init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        return { body: { job: `plan-${requests.length}` } };
      }
      return undefined;
    });
    return requests;
  }
  const renderInstall = (uploads: UploadEntry[]) =>
    render(
      <AppProvider initialState={{ ...baseState, uploads }}>
        <InstallTab ctx={ctx} />
        <ToastHost />
      </AppProvider>,
    );

  it("ignores a plan that finishes after its options changed, and plans again", async () => {
    const requests = stubInstall();
    renderInstall([upload("Alpha")]);
    await waitFor(() => expect(FakeEventSource.all).toHaveLength(1));
    expect(requests[0]).toMatchObject({ duplicateMode: "replace", dryRun: true });

    // The option changes while the first plan is still being built.
    fireEvent.change(screen.getByLabelText("When an older version is on the server"), { target: { value: "skip" } });
    FakeEventSource.all[0]!.end(planOf("Planned for replace"));

    await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
    expect(requests[1]).toMatchObject({ duplicateMode: "skip", dryRun: true });
    expect(screen.queryByText("Planned for replace")).toBeNull();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();

    FakeEventSource.all[1]!.end(planOf("Planned for skip"));
    expect(await screen.findByText("Planned for skip")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install 1 pack" })).toBeEnabled();
  });

  it("plans again after a failed upload, since part of it may be staged", async () => {
    const requests = stubInstall();
    vi.mocked(uploadFile).mockRejectedValue(new Error("disk full"));
    vi.mocked(getUploads).mockResolvedValue({ uploads: [upload("Half")] });
    const { container } = renderInstall([]);
    expect(requests).toHaveLength(0);

    const input = container.querySelector<HTMLInputElement>("input[type='file']:not([webkitdirectory])")!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "Half.mcpack")], configurable: true });
    fireEvent.change(input);

    expect(await screen.findByText("Upload failed: disk full")).toBeInTheDocument();
    expect(screen.getByText("Half")).toBeInTheDocument();
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("says so when only system files were added", async () => {
    stubInstall();
    const { container } = renderInstall([]);
    const input = container.querySelector<HTMLInputElement>("input[type='file']:not([webkitdirectory])")!;
    Object.defineProperty(input, "files", { value: [new File(["x"], ".DS_Store")], configurable: true });
    fireEvent.change(input);
    expect(await screen.findByText(/Nothing usable was found/)).toBeInTheDocument();
    expect(uploadFile).not.toHaveBeenCalled();
  });
});

describe("stale link", () => {
  const badToken = { status: 403, body: { error: "Missing or wrong token.", code: "bad_token" } };

  it("shows one banner when the first read is refused", async () => {
    stubFetch(() => badToken);
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(STALE_LINK_MESSAGE);
  });

  it("replaces the error toast with a lasting banner when a later call is refused", async () => {
    const profile = { name: "SMP", settings: { protocol: "sftp", host: "h", port: null, username: "u", root: "" }, layout: {} };
    stubFetch((url, init) => {
      if (url === ROUTES.state) return { body: { ...baseState, connected: false, profiles: [profile] } };
      if (init?.method === "DELETE") return badToken;
      return undefined;
    });
    render(
      <AppProvider>
        <App />
      </AppProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete SMP" }));
    // Deleting a saved server asks first; Cancel starts focused because it is destructive.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(STALE_LINK_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("Missing or wrong token.")).toBeNull();
  });
});

describe("dialog focus", () => {
  function Asker({ danger }: { danger: boolean }) {
    const { confirm } = useApp();
    return <button onClick={() => void confirm({ title: "Sure?", body: <p>Body</p>, okLabel: "Go", danger })}>Ask</button>;
  }
  const renderAsker = (danger: boolean) =>
    render(
      <AppProvider>
        <Asker danger={danger} />
        <ConfirmHost />
      </AppProvider>,
    );

  it("focuses the marked element even when other candidates come first", () => {
    render(
      <Modal title="Pick" onClose={() => undefined}>
        <input aria-label="Name" />
        <button className="btn primary">Save</button>
        <button data-autofocus>Marked</button>
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Marked" })).toHaveFocus();
  });

  it("prefers a form field, then the primary button, over earlier buttons", () => {
    const { unmount } = render(
      <Modal title="Form" onClose={() => undefined}>
        <button>Browse</button>
        <input aria-label="Folder" />
      </Modal>,
    );
    expect(screen.getByLabelText("Folder")).toHaveFocus();
    unmount();
    render(
      <Modal title="Buttons" onClose={() => undefined}>
        <button>Other</button>
        <button className="btn primary">Main</button>
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Main" })).toHaveFocus();
  });

  it("starts confirmations on the action", () => {
    renderAsker(false);
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("button", { name: "Go" })).toHaveFocus();
  });

  it("starts destructive confirmations on Cancel", () => {
    renderAsker(true);
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
