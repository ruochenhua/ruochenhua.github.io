/**
 * 兼容 Fluid 主题的 index_img / banner_img 到 Butterfly 的 cover / top_img
 * 这样无需改每篇文章的 front matter 即可在 Butterfly 下正确显示首页封面和文章顶图
 */
'use strict';

const imgExtReg = /\.(png|jpe?g|gif|svg|webp|avif)(\?.*)?$/i;

hexo.extend.filter.register('before_post_render', function (data) {
  if (!data) return data;

  // 首页/列表卡片图：Fluid 的 index_img → Butterfly 的 cover
  if (data.index_img != null && data.cover == null) {
    data.cover = data.index_img;
  }
  // 文章顶图/Banner：Fluid 的 banner_img → Butterfly 的 top_img
  if (data.banner_img != null && data.top_img == null) {
    data.top_img = data.banner_img;
  }
  // 若未单独设置 top_img，文章页顶图可回退到 cover（Butterfly 已支持 top_img || cover）
  if (data.cover && (data.top_img == null || data.top_img === '')) {
    data.top_img = data.top_img ?? data.cover;
  }
  if (data.cover && imgExtReg.test(String(data.cover))) {
    data.cover_type = 'img';
  }

  return data;
});
