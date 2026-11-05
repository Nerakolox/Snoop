/**
 * 更新日志弹窗的全局入口。
 *
 * 为什么要有 Provider，而不是让设置页自己渲染弹窗：
 *   1. 入口不该只有一处。今天挂在设置页版本号旁边，将来托盘菜单、关于页、
 *      更新成功的提示条都可能要开同一个弹窗。挂在 App 根部，谁调用都行。
 *   2. 弹窗只有一份实例，未读标记（红点）的状态也只有一份，不会出现两个入口
 *      各算一套「看过没有」。
 *
 * 数据加载也在这里做：挂载即预拉一次，等用户点开时内容已经在手里，
 * 弹窗不转圈。拉取失败会安静地退回本地缓存/种子，见 source.ts。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ChangelogDialog from "./ChangelogDialog";
import {
  hasUnseenRelease,
  hasUnseenVersion,
  loadChangelog,
  markChangelogSeen,
  markVersionSeen,
  useChangelog,
} from "../../changelog/source";
import { loadAppVersion } from "../../changelog/appVersion";
import { compareVersions } from "../../changelog/version";

/** 上次运行过的版本。用它判断「这次启动是不是刚升级（或首次安装）」。 */
const LAST_RUN_KEY = "snoop.app.lastRunVersion";

/** 自动弹窗的启动延迟：让主界面先渲染完，别在启动瞬间糊一层遮罩。 */
const AUTO_SHOW_DELAY_MS = 1400;

interface ChangelogDialogApi {
  /** 打开弹窗。打开的瞬间即标记为已读，红点随之消失。 */
  open: () => void;
  /** 是否存在未被查看过的更新条目。入口据此显示红点。 */
  hasUnseen: boolean;
  /** 开发预览：清掉「上次运行版本」，按启动时的延迟自动弹一次。 */
  previewUpgrade: () => void;
}

const ChangelogDialogCtx = createContext<ChangelogDialogApi | null>(null);

export function ChangelogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const snapshot = useChangelog();

  // 挂载即预拉：弹窗点开就是内容，没有「正在加载」这一步
  useEffect(() => {
    void loadChangelog();
    void loadAppVersion().then(setAppVersion);
  }, []);

  const [seenVersion, setSeenVersion] = useState<string | null>(null);

  const hasUnseen = useMemo(() => {
    if (!snapshot) return false;
    const newest = snapshot.data.releases[0];
    if (!newest) return false;
    // 本次会话里已经点开过：立刻消红点，不等下次读取 localStorage
    if (seenVersion !== null) return newest.version !== seenVersion;
    return hasUnseenRelease(snapshot.data);
  }, [snapshot, seenVersion]);

  const [onlyVersion, setOnlyVersion] = useState<string | null>(null);

  /**
   * 打开弹窗。传 only 时只展示该版本（升级后的视角），否则展示完整时间线。
   * 已读水位也只记到这里指定的版本，避免把云端提前写好的下一版一并吞掉。
   */
  const openWith = useCallback((only: string | null) => {
    const target = only && only.trim() ? only : null;
    setIsOpen(true);
    setOnlyVersion(target);
    if (target) {
      markVersionSeen(target);
      setSeenVersion(target);
      return;
    }
    if (snapshot) {
      const newest = snapshot.data.releases[0];
      if (newest) {
        markChangelogSeen(snapshot.data);
        setSeenVersion(newest.version);
      }
    }
  }, [snapshot]);

  const open = useCallback(() => openWith(null), [openWith]);

  const close = useCallback(() => setIsOpen(false), []);

  // ─── 升级后自动弹一次 ──────────────────────────────────────────────────────
  //
  // 判断依据是「上次运行版本」而不是「上次看过日志」：用户可能只是重开应用，
  // 不该每开一次就弹一遍；而升到新版本时，哪怕红点还在，也应该主动把内容
  // 送到眼前。首次安装（没有记录）同样弹一次。
  const [autoShowPending, setAutoShowPending] = useState(false);
  const autoEvaluated = useRef(false);

  useEffect(() => {
    if (autoEvaluated.current || !appVersion || !snapshot) return;
    const data = snapshot.data;
    if (data.releases.length === 0) return; // 内容还没到手，等下一次 snapshot

    autoEvaluated.current = true;

    let lastRun: string | null = null;
    try {
      lastRun = localStorage.getItem(LAST_RUN_KEY);
    } catch {
      // 读不到就当首次运行
    }
    try {
      // 先记下本次运行版本：无论弹不弹，同一版本都不该因崩溃重启再弹一次
      localStorage.setItem(LAST_RUN_KEY, appVersion);
    } catch {
      // 写不进去最多下次多弹一次，不影响功能
    }

    if (lastRun !== null && compareVersions(appVersion, lastRun) <= 0) return;

    // 日志里必须真有当前这一版；拿旧内容冒充「新版」不如不弹
    const hasCurrent = data.releases.some(
      (r) => compareVersions(r.version, appVersion) === 0,
    );
    // 更新前可能在旧版本里点开日志看过这一版了（云端日志常比安装包先上线）
    if (!hasCurrent || !hasUnseenVersion(appVersion)) return;

    setAutoShowPending(true);
  }, [appVersion, snapshot]);

  useEffect(() => {
    if (!autoShowPending) return;
    const timer = window.setTimeout(() => {
      setAutoShowPending(false);
      // 只弹刚安装的这一版，不把整条历史线倒给用户
      openWith(appVersion || null);
    }, AUTO_SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoShowPending, openWith, appVersion]);

  // Dev →「弹窗预览」用：重复点击也要能重新走一遍延迟，所以先落回 false。
  // 只改运行时状态，不动 localStorage——不然「预览一次」会把真实升级记录吃掉。
  const previewUpgrade = useCallback(() => {
    setIsOpen(false);
    setAutoShowPending(false);
    window.setTimeout(() => setAutoShowPending(true), 0);
  }, []);

  const api = useMemo<ChangelogDialogApi>(
    () => ({ open, hasUnseen, previewUpgrade }),
    [open, hasUnseen, previewUpgrade],
  );

  return (
    <ChangelogDialogCtx.Provider value={api}>
      {children}
      {isOpen && (
        <ChangelogDialog
          appVersion={appVersion}
          onlyVersion={onlyVersion}
          onClose={close}
        />
      )}
    </ChangelogDialogCtx.Provider>
  );
}

export function useChangelogDialog(): ChangelogDialogApi {
  const v = useContext(ChangelogDialogCtx);
  if (!v) throw new Error("useChangelogDialog 必须在 ChangelogProvider 内使用");
  return v;
}
