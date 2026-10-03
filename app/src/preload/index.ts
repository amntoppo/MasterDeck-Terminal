import { homedir } from "node:os";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH, type DeckApi } from "@shared/ipc";

function listen<T extends unknown[]>(
  channel: string,
  cb: (...args: T) => void,
): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

const api: DeckApi = {
  platform: process.platform,
  home: homedir(),
  getState: () => ipcRenderer.invoke(CH.getState),
  watchStop: (id) => ipcRenderer.invoke(CH.watchStop, id),
  accountSignIn: (provider) => ipcRenderer.invoke(CH.accountSignIn, provider),
  accountCancel: () => ipcRenderer.invoke(CH.accountCancel),
  accountReopen: () => ipcRenderer.invoke(CH.accountReopen),
  accountUseCode: () => ipcRenderer.invoke(CH.accountUseCode),
  accountProviders: () => ipcRenderer.invoke(CH.accountProviders),
  accountEmail: (a) => ipcRenderer.invoke(CH.accountEmail, a),
  accountSignOut: () => ipcRenderer.invoke(CH.accountSignOut),
  accountManage: () => ipcRenderer.invoke(CH.accountManage),
  browserDecide: (id, allow) => ipcRenderer.invoke(CH.browserDecide, id, allow),
  browserRevoke: (id) => ipcRenderer.invoke(CH.browserRevoke, id),
  onState: (cb) => listen(CH.state, cb),
  onFocusSession: (cb) => listen(CH.focusSession, cb),
  onShowNeedsYou: (cb) => listen(CH.showNeedsYou, cb),
  onShowInboxItem: (cb) => listen(CH.showInboxItem, cb),
  approve: (id) => ipcRenderer.invoke(CH.approve, id),
  reject: (id) => ipcRenderer.invoke(CH.reject, id),
  draftAssign: (issue, title, url) =>
    ipcRenderer.invoke(CH.draftAssign, issue, title, url),
  setSprint: (sprint) => ipcRenderer.send(CH.setSprint, sprint),
  prSummary: (url) => ipcRenderer.invoke(CH.prSummary, url),
  issueBody: (ticket) => ipcRenderer.invoke(CH.issueBody, ticket),
  shellPrepare: (dir) => ipcRenderer.invoke(CH.shellPrepare, dir),
  ticketMemory: (ticket) => ipcRenderer.invoke(CH.ticketMemory, ticket),
  assignIssue: (issue, login, current) =>
    ipcRenderer.invoke(CH.assignIssue, issue, login, current),
  startHere: (o) => ipcRenderer.invoke(CH.startHere, o),
  sendText: (key, text) => ipcRenderer.invoke(CH.sendText, key, text),
  answerMenu: (key, question, answer) =>
    ipcRenderer.invoke(CH.answerMenu, key, question, answer),
  inboxAct: (id, type, payload) =>
    ipcRenderer.invoke(CH.inboxAct, id, type, payload ?? {}),
  queueList: (sessionId) => ipcRenderer.invoke(CH.queueList, sessionId),
  queueEdit: (sessionId, edit) =>
    ipcRenderer.invoke(CH.queueEdit, sessionId, edit),
  queueSendNext: (key) => ipcRenderer.invoke(CH.queueSendNext, key),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setSettings: (s) => ipcRenderer.invoke(CH.setSettings, s),
  onAutoOpen: (cb) => listen(CH.autoOpen, cb),
  setStatus: (issue, status) => ipcRenderer.invoke(CH.setStatus, issue, status),
  standupCommits: (since, dirs, until) =>
    ipcRenderer.invoke(CH.standupCommits, since, dirs, until),
  janitor: (dirs, force) => ipcRenderer.invoke(CH.janitor, dirs, force),
  removeWorktree: (repo, path, force) =>
    ipcRenderer.invoke(CH.removeWorktree, repo, path, force),
  removeSession: (bgId) => ipcRenderer.invoke(CH.removeSession, bgId),
  searchHistory: (q) => ipcRenderer.invoke(CH.searchHistory, q),
  historyTranscript: (path, query, focus) =>
    ipcRenderer.invoke(CH.historyTranscript, path, query, focus),
  templates: () => ipcRenderer.invoke(CH.templates),
  saveTemplate: (t) => ipcRenderer.invoke(CH.saveTemplate, t),
  deleteTemplate: (name) => ipcRenderer.invoke(CH.deleteTemplate, name),
  ticketBuilderPrepare: (ctx) =>
    ipcRenderer.invoke(CH.ticketBuilderPrepare, ctx),
  onTicketsCreated: (cb) => listen(CH.ticketsCreated, cb),
  ticketCreate: (req) => ipcRenderer.invoke(CH.ticketCreate, req),
  ticketRepoMeta: (repo) => ipcRenderer.invoke(CH.ticketRepoMeta, repo),
  workspaceRepos: () => ipcRenderer.invoke(CH.workspaceRepos),
  startClaude: (req) => ipcRenderer.invoke(CH.startClaude, req),
  resumeSession: (id, name, cwd) =>
    ipcRenderer.invoke(CH.resumeSession, id, name, cwd),
  resumeStopped: () => ipcRenderer.invoke(CH.resumeStopped),
  tokensByDay: (ids) => ipcRenderer.invoke(CH.tokensByDay, ids),
  dismissStopped: () => ipcRenderer.invoke(CH.dismissStopped),
  assign: (req) => ipcRenderer.invoke(CH.assign, req),
  defaultModel: () => ipcRenderer.invoke(CH.defaultModel),
  refresh: () => ipcRenderer.invoke(CH.refresh),
  refreshBoard: () => ipcRenderer.invoke(CH.boardRefresh),
  refreshTeamPrs: (maxAgeMs) => ipcRenderer.invoke(CH.teamPrsRefresh, maxAgeMs),
  setupCheck: () => ipcRenderer.invoke(CH.setupCheck),
  setupTool: (tool) => ipcRenderer.invoke(CH.setupTool, tool),
  ghAccounts: () => ipcRenderer.invoke(CH.ghAccounts),
  ghUser: (login) => ipcRenderer.invoke(CH.ghUser, login),
  ghOwners: () => ipcRenderer.invoke(CH.ghOwners),
  configDetect: (owner, project) =>
    ipcRenderer.invoke(CH.configDetect, owner, project),
  configDetectAll: (login) => ipcRenderer.invoke(CH.configDetectAll, login),
  configSave: (patch) => ipcRenderer.invoke(CH.configSave, patch),
  pickFolder: (start) => ipcRenderer.invoke(CH.pickFolder, start),
  skillReinstall: (name) => ipcRenderer.invoke(CH.skillReinstall, name),
  skillRemove: (name) => ipcRenderer.invoke(CH.skillRemove, name),
  workflowGet: () => ipcRenderer.invoke(CH.workflowGet),
  workflowSave: (steps) => ipcRenderer.invoke(CH.workflowSave, steps),
  workflowTemplateSave: (id, name, steps) =>
    ipcRenderer.invoke(CH.workflowTemplateSave, id, name, steps),
  workflowTemplateDelete: (id) =>
    ipcRenderer.invoke(CH.workflowTemplateDelete, id),
  workflowBuilderPrepare: (templateId) =>
    ipcRenderer.invoke(CH.workflowBuilderPrepare, templateId),
  workflowDraftGet: () => ipcRenderer.invoke(CH.workflowDraftGet),
  onWorkflowDraft: (cb) => listen(CH.workflowDraft, cb),
  workflowDraftApply: (target) =>
    ipcRenderer.invoke(CH.workflowDraftApply, target),
  workflowTriggerDelete: (id) =>
    ipcRenderer.invoke(CH.workflowTriggerDelete, id),
  workflowDraftDiscard: () => ipcRenderer.invoke(CH.workflowDraftDiscard),
  workflowStatus: (sid) => ipcRenderer.invoke(CH.workflowStatus, sid),
  sessionWorkflowGet: (sid) => ipcRenderer.invoke(CH.sessionWorkflowGet, sid),
  sessionWorkflowSave: (sid, steps, from) =>
    ipcRenderer.invoke(CH.sessionWorkflowSave, sid, steps, from ?? null),
  summaryGet: (key) => ipcRenderer.invoke(CH.summaryGet, key),
  summaryMake: (key) => ipcRenderer.invoke(CH.summaryMake, key),
  summaryPost: (key) => ipcRenderer.invoke(CH.summaryPost, key),
  linkSession: (issue, sessionId, cwd) =>
    ipcRenderer.invoke(CH.linkSession, issue, sessionId, cwd),
  setBoardOpen: (open) => ipcRenderer.send(CH.boardOpen, open),
  setFocus: (id) => ipcRenderer.send(CH.setFocus, id),
  setVisible: (ids) => ipcRenderer.send(CH.setVisible, ids),
  openExternal: (url) => ipcRenderer.send(CH.openExternal, url),
  openEditor: (dir) => ipcRenderer.invoke(CH.openEditor, dir),
  copy: (text) => ipcRenderer.send(CH.copy, text),
  stopSession: (bgId, name) => ipcRenderer.invoke(CH.stopSession, bgId, name),
  stopOtherSession: (pid, name) =>
    ipcRenderer.invoke(CH.stopOtherSession, pid, name),
  stopSessions: (keys) => ipcRenderer.invoke(CH.stopSessions, keys),
  setManualStatus: (key, status) =>
    ipcRenderer.invoke(CH.setManualStatus, key, status),
  statuslineInstall: () => ipcRenderer.invoke(CH.statuslineInstall),
  statuslineUninstall: () => ipcRenderer.invoke(CH.statuslineUninstall),
  masterStart: () => ipcRenderer.invoke(CH.masterStart),
  ptyOpen: (id, spec, cols, rows) =>
    ipcRenderer.invoke(CH.ptyOpen, id, spec, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.send(CH.ptyWrite, id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send(CH.ptyResize, id, cols, rows),
  ptyClose: (id) => ipcRenderer.send(CH.ptyClose, id),
  onPtyData: (id, cb) => listen(`${CH.ptyData}:${id}`, cb),
  onPtyExit: (id, cb) => listen(`${CH.ptyExit}:${id}`, cb),
};

contextBridge.exposeInMainWorld("deck", api);
if (process.env.MASTERDECK_CAPTURE)
  contextBridge.exposeInMainWorld("testShot", (name: string) =>
    ipcRenderer.invoke("test:shot", name),
  );
