/**
 * dsh-powerbox — sidebar-layout 宿主半区（刻意留空）。
 *
 * 与原 @local/sidebar-button-layout 相同：功能 100% 在浏览器侧
 * （client/sidebar-layout.js），宿主行只是客户端模块被装载的凭据。
 */

/** 空注入：本功能不依赖任何宿主服务。 */
export const inject = [];

/** 无操作的宿主 apply。 */
export function apply() {}
