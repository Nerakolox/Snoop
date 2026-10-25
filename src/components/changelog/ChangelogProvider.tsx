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
  useState,
  type ReactNode,
} from "react";
import ChangelogDialog from "./ChangelogDialog";
import {
  hasUnseenRelease,
  loadChangelog,
  markChangelogSeen,
  useChangelog,
} from "../../changelog/source";
import { loadAppVersion } from "../../changelog/appVersion";

interface ChangelogDialogApi {
  /** 打开弹窗。打开的瞬间即标记为已读，红点随之消失。 */
  open: () => void;
  /** 是否存在未被查看过的更新条目。入口据此显示红点。 */
  hasUnseen: boolean;
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

  const open = useCallback(() => {
    setIsOpen(true);
    if (snapshot) {
      const newest = snapshot.data.releases[0];
      if (newest) {
        markChangelogSeen(snapshot.data);
        setSeenVersion(newest.version);
      }
    }
  }, [snapshot]);

  const close = useCallback(() => setIsOpen(false), []);

  const api = useMemo<ChangelogDialogApi>(() => ({ open, hasUnseen }), [open, hasUnseen]);

  return (
    <ChangelogDialogCtx.Provider value={api}>
      {children}
      {isOpen && <ChangelogDialog appVersion={appVersion} onClose={close} />}
    </ChangelogDialogCtx.Provider>
  );
}

export function useChangelogDialog(): ChangelogDialogApi {
  const v = useContext(ChangelogDialogCtx);
  if (!v) throw new Error("useChangelogDialog 必须在 ChangelogProvider 内使用");
  return v;
}
