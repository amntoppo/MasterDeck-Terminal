import { homedir } from 'node:os'
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH, type DeckApi } from '@shared/ipc'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: DeckApi = {
  platform: process.platform,
  home: homedir(),
  getState: () => ipcRenderer.invoke(CH.getState),
  onState: (cb) => listen(CH.state, cb),
  onFocusSession: (cb) => listen(CH.focusSession, cb),
  onShowNeedsYou: (cb) => listen(CH.showNeedsYou, cb),
  approve: (id) => ipcRenderer.invoke(CH.approve, id),
  reject: (id) => ipcRenderer.invoke(CH.reject, id),
  draftAssign: (issue, title, url) => ipcRenderer.invoke(CH.draftAssign, issue, title, url),
  setSprint: (sprint) => ipcRenderer.send(CH.setSprint, sprint),
  prSummary: (url) => ipcRenderer.invoke(CH.prSummary, url),
  assignIssue: (issue, login, current) => ipcRenderer.invoke(CH.assignIssue, issue, login, current),
  startHere: (o) => ipcRenderer.invoke(CH.startHere, o),
  sendText: (key, text) => ipcRenderer.invoke(CH.sendText, key, text),
  queueList: (sessionId) => ipcRenderer.invoke(CH.queueList, sessionId),
  queueEdit: (sessionId, edit) => ipcRenderer.invoke(CH.queueEdit, sessionId, edit),
  queueSendNext: (key) => ipcRenderer.invoke(CH.queueSendNext, key),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setSettings: (s) => ipcRenderer.invoke(CH.setSettings, s),
  onAutoOpen: (cb) => listen(CH.autoOpen, cb),
  setStatus: (issue, status) => ipcRenderer.invoke(CH.setStatus, issue, status),
  standupCommits: (since, dirs, until) => ipcRenderer.invoke(CH.standupCommits, since, dirs, until),
  janitor: (dirs, force) => ipcRenderer.invoke(CH.janitor, dirs, force),
  removeWorktree: (repo, path, force) => ipcRenderer.invoke(CH.removeWorktree, repo, path, force),
  removeSession: (bgId) => ipcRenderer.invoke(CH.removeSession, bgId),
  searchHistory: (q) => ipcRenderer.invoke(CH.searchHistory, q),
  templates: () => ipcRenderer.invoke(CH.templates),
  saveTemplate: (t) => ipcRenderer.invoke(CH.saveTemplate, t),
  deleteTemplate: (name) => ipcRenderer.invoke(CH.deleteTemplate, name),
  resumeSession: (id, name, cwd) => ipcRenderer.invoke(CH.resumeSession, id, name, cwd),
  resumeStopped: () => ipcRenderer.invoke(CH.resumeStopped),
  dismissStopped: () => ipcRenderer.invoke(CH.dismissStopped),
  assign: (req) => ipcRenderer.invoke(CH.assign, req),
  defaultModel: () => ipcRenderer.invoke(CH.defaultModel),
  refresh: () => ipcRenderer.invoke(CH.refresh),
  refreshBoard: () => ipcRenderer.invoke(CH.boardRefresh),
  refreshTeamPrs: (maxAgeMs) => ipcRenderer.invoke(CH.teamPrsRefresh, maxAgeMs),
  setupCheck: () => ipcRenderer.invoke(CH.setupCheck),
  configDetect: (owner, project) => ipcRenderer.invoke(CH.configDetect, owner, project),
  configSave: (patch) => ipcRenderer.invoke(CH.configSave, patch),
  pickFolder: (start) => ipcRenderer.invoke(CH.pickFolder, start),
  hooksInstall: (which) => ipcRenderer.invoke(CH.hooksInstall, which),
  skillReinstall: (name) => ipcRenderer.invoke(CH.skillReinstall, name),
  linkSession: (issue, sessionId, cwd) => ipcRenderer.invoke(CH.linkSession, issue, sessionId, cwd),
  setBoardOpen: (open) => ipcRenderer.send(CH.boardOpen, open),
  setFocus: (id) => ipcRenderer.send(CH.setFocus, id),
  setVisible: (ids) => ipcRenderer.send(CH.setVisible, ids),
  openExternal: (url) => ipcRenderer.send(CH.openExternal, url),
  openEditor: (dir) => ipcRenderer.invoke(CH.openEditor, dir),
  copy: (text) => ipcRenderer.send(CH.copy, text),
  stopSession: (bgId, name) => ipcRenderer.invoke(CH.stopSession, bgId, name),
  statuslineInstall: () => ipcRenderer.invoke(CH.statuslineInstall),
  statuslineUninstall: () => ipcRenderer.invoke(CH.statuslineUninstall),
  masterStart: () => ipcRenderer.invoke(CH.masterStart),
  ptyOpen: (id, spec, cols, rows) => ipcRenderer.invoke(CH.ptyOpen, id, spec, cols, rows),
  ptyWrite: (id, data) => ipcRenderer.send(CH.ptyWrite, id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send(CH.ptyResize, id, cols, rows),
  ptyClose: (id) => ipcRenderer.send(CH.ptyClose, id),
  onPtyData: (id, cb) => listen(`${CH.ptyData}:${id}`, cb),
  onPtyExit: (id, cb) => listen(`${CH.ptyExit}:${id}`, cb),
}

contextBridge.exposeInMainWorld('deck', api)
if (process.env.MASTERDECK_CAPTURE) contextBridge.exposeInMainWorld('testShot', (name: string) => ipcRenderer.invoke('test:shot', name))
