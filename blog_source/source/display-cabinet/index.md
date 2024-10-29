---
title: 展示窗
subtitle: 我的作品展示
date: 2024-10-29 22:01:23
---

这里是展示窗，是我showcase一些自己的成果的地方，包括代码、github链接等等各种各样的小玩意。

<div class="markdown-body">

# ShaderToy
ShaderToy是一个很有趣的网站，它上面分享了很多实现很酷炫效果的着色器代码。我在上面也有一些分享，下面展示的是我认为可能还算不错作品，或者是对我有意义的学习内容。

## 大气渲染

<iframe width="640" height="360" frameborder="0" src="https://www.shadertoy.com/embed/XXBcRR?gui=true&t=10&paused=true&muted=false" allowfullscreen></iframe>

这个demo是天空大气的渲染，基于单次散射模型（有一篇文章有提到过）。是个挺有趣的小例子，修改Shader代码可以尝试将相机抬升，将会展示在外太空看向地球的大气效果。


## 简单海平面

<iframe width="640" height="360" frameborder="0" src="https://www.shadertoy.com/embed/X3ByDD?gui=true&t=10&paused=true&muted=false" allowfullscreen></iframe>

这个demo稍微复杂了那么一丢丢，它是由上面的天空大气的demo增加了一些细节而来。云和海水的纹理都是通过柏林噪声来生成的（这就是图形编程的魅力所在吧，仅仅通过代码就能生成逼真的画面）。

流程大概是先计算天空大气的颜色；然后通过噪音生成3D空间的云的密度函数，通过采样一定范围的空气密度来在画面的上半部分渲染云。渲染完成后将云沿着横轴翻转，再配合上噪音生成的海水波纹。


## 程序化地形

<iframe width="640" height="360" frameborder="0" src="https://www.shadertoy.com/embed/4XByRV?gui=true&t=10&paused=true&muted=false" allowfullscreen></iframe>

这个demo的灵感来源于Inigo大佬的一篇教程：https://www.shadertoy.com/view/4ttSWf。

和教程有所差异的是我选择了使用无线地形的生成，而不是一个固定的角度。

从效果来看是比较震撼的，不过性能上还是有诸多问题，raymarch地形在现在看来还是比较难做到高性能和高质量检具的结果。

另外云（高层和低层）的效果我并不是特别满意，后续还想改成更为复杂一点的效果，并且加上阴影等。

## domain warp

<iframe width="640" height="360" frameborder="0" src="https://www.shadertoy.com/embed/lXfBWX?gui=true&t=10&paused=true&muted=false" allowfullscreen></iframe>

这个demo是用于学习domain warp的例子。domain warp实际上就是将FBM的输出作为另一个FBM的输入，调整合适的参数和迭代后得到的很特殊的效果。这个demo里面我默认将domain wrap的结果作为raymarch sphere的材质。

## flow effect

<iframe width="640" height="360" frameborder="0" src="https://www.shadertoy.com/embed/MXffDX?gui=true&t=10&paused=true&muted=false" allowfullscreen></iframe>

这个demo和上面的类似，是我学习flow效果的一个练手作品。
其实现过程是用FBM计算出平面上某个点的流动方向f，并在0帧初始化最初的颜色后，然后从往后的每一帧，每个像素的颜色都遵循f的方向流动并记录成材质，循环往复。

另外这个flow上的阴影效果是根据颜色的blue值来决定的，只是调了一个好看的效果而已。


# GitHub
这里是我做的一些放在GitHub上面的工程。

## KongEngine
https://github.com/ruochenhua/KongEngine

KongEngine是我在2019年开始的一个基于OpenGL的渲染项目，但是后面由于各种原因更新了没有多少功能就弃置了，在2020年提交了最后一个commit就没有动静，最终的效果也如下图所示。

![2020年的最后一次提交](/img/og_tinyGL.png)


2024年我重新拾起这个项目的开发，并在原来非常简单的渲染效果上增加了很多额外的功能，这也是我希望我能够一直进行下去的项目。

</div>