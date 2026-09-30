/**
 * dsh-powerbox — workspace-activity 宿主半区（刻意留空）。
 *
 * 与原 dsh-workspace-activity 相同：功能 100% 在浏览器侧（client/workspace-activity.js），
 * 宿主行的意义是让 @deepseek-ai/dsh-client-modules 把本包的 dsh.client 清单
 * 扫进 window.__DSH_BOOT__ 的客户端模块图。
 */

/** 空注入：本功能不依赖任何宿主服务。 */
export const inject = [];

/** 无操作的宿主 apply；存在本身就是装载凭据。 */
export function apply() {}
