---
title: 景深的简单实现
date: 2024-10-28 22:11:58
categories: 
	- 技术漫谈
tags: [3D, render, 渲染, 编程]
index_img: /2024/10/28/depth-of-field/game1.jpg
banner_img: /2024/10/28/depth-of-field/game1.jpg
---

# 关于景深
景深是一个常在摄像领域出现的词，它一般指的是沿着摄像机或其他成像器的拍摄方向上，能够取得清晰图像的成像所测定的被摄物体前后距离范围。用大白话就是说，拥有浅景深的成像器拍摄出来的效果，是只有焦点附近的图像是清晰的，其他地方的图像都是模糊的；而拥有大景深则可以在离焦点很远的地方也能有清晰的图像。

![一张浅景深的照片](dof_butterfly.JPG)

有了景深效果的图像可以有重点的突出核心想要表达的内容，不仅仅在摄影摄像的领域有非常多的应用，在游戏领域内也是应用广泛，可以表现出很独特的风格化美术效果（如八方旅人的浅景深效果）。

![八方旅人](game1.jpg)

下面我来介绍一种基础的景深效果实现，这个方法也在最近接入了[KongEngine](https://github.com/ruochenhua/KongEngine)


# 渲染散景
浅景深的主要应用是通过调整不同焦距上物体的成像清晰程度来突出渲染画面的重点。清晰的部分我们已经掌握了，就是正常的将场景渲染出来，那不清晰的部分（或者叫做散景）也有不少的实现方式，一般是通过模糊算法来实现。

模糊的算法有很多种，比如box blur，gaussian blur等等，效果最好的是扩张模糊(dilate blur)，这也是我们会采取的方法。

## 扩张模糊（dilate blur)
扩张模糊它的主要方式，是在给定一个模糊的窗口下，取得这个窗口下的最亮的颜色记录下来，然后将这个最亮的颜色扩张到整个窗口。这样一来经过扩张模糊的画面会有一种亮晶晶，并且很柔和的效果，很适合作为散景的表现效果。

dilate blur的计算也比较简单，首先我们定义此次blur的窗口大小已经采样的间隔大小。

``` glsl
// 窗口的大小，数值越大扩散越大，消耗越高 
int size = 5;	
// 采样间隔的大小，数值越大扩散越大，效果降低
float separation = 1.0;
```

在定义了窗口的尺寸之后，我们在窗口的范围内记录最亮的像素颜色，并保存下来。**窗口的形状不限**，可以是矩形，或者圆形。我们这里实现采取圆形的窗口。

``` glsl
// 渲染场景的尺寸
vec2 tex_size = vec2(textureSize(scene_texture, 0).xy);
// 获取场景的原本颜色
FragColor = texture(scene_texture, TexCoords);

if(size <= 0) return;
float mx = 0.0;
vec4 cmx = FragColor;

for(int i = -size; i <= size; ++i)
{
	for(int j = -size; j <= size; ++j)
	{
		// dilate的形状可以多样，如圆形，矩形等等，根据采样点的形状来决定
		// 这里使用圆形的dilate
		if(distance(vec2(i,j), vec2(0)) > size) continue;

		// 采样区域内点的颜色，不要越界出去了
		vec2 sample_coord = TexCoords + vec2(i, j)*separation/tex_size;
		if(sample_coord.x > 1.0 || sample_coord.x < 0.0 || sample_coord.y > 1.0 || sample_coord.y < 0.0)
				continue;

		// 拿到采样点
		vec4 c = texture(scene_texture, sample_coord);

		// 和目标颜色做点乘，得到一个灰度值
		float mxt = dot(c.rgb, vec3(0.3, 0.59, 0.11));

		// 保存区域内灰度值最大的颜色
		if(mxt > mx)
		{
			mx = mxt;
			cmx = c;
		}
	}
}
```

这里我们计算最亮区域的方式是通过和一个目标颜色**(0.3, 0.59, 0.11)**来做点乘，当然也可以通过和其他的目标颜色，或者其他的方式来实现。

最后，我们得到窗口区域内最亮的颜色，我们的最终颜色是原本颜色和最亮颜色的差值。
```glsl
// 模糊采样的颜色和原始颜色的mix上下限
float min_threshold = 0.1;
float max_threshold = 0.3;

// 最终颜色是原来颜色和区域内灰度值最大的采样颜色的混合，有上下限做限制
FragColor.rgb = mix(FragColor.rgb, cmx.rgb, smoothstep(min_threshold, max_threshold, mx));
```
这里我们还是采用了一个上下限，尽量控制增亮的程度。

## 散景的效果
这里给出经过扩张模糊得到的散景效果。下面这张图是扩张模糊之前的效果。
![扩张模糊前](dilate_before.png)
下面这张图是扩张模糊之后的效果。
![扩张模糊后](dilate_after.png)

当然在实际的场景中，我们可能不会开这么大的扩散效果，此处只是作为对比。

# 结合场景
好了，现在我们有原本场景的渲染效果和扩散后的效果，实现最终的景深效果需要将这两者结合起来。我们需要一种方法来决定画面上哪些部分是需要采用清晰的图像，哪些是采用模糊的图像。

为了实现这个效果我们需要获得画面上每个点的深度，或者每个点的实际世界坐标。幸运的是，我们在实现[延迟渲染](https://ruochenhua.github.io/2024/10/19/defer-render/)的时候已经将这些存放到缓冲中去了，接下来就是实现景深效果了。

最终的代码如下：
``` glsl
out vec4 FragColor;
in vec2 TexCoords;

uniform sampler2D scene_texture;
uniform sampler2D dilate_texture;
uniform sampler2D position_texture;

// 焦点距离
uniform float focus_distance = 3.0;
uniform vec2 focus_threshold;
// 景深的上下限
float min_dist = focus_threshold.x;
float max_dist = focus_threshold.y;

void main()
{
    vec4 focus_color = texture(scene_texture, TexCoords);
    vec4 out_of_focus_color = texture(dilate_texture, TexCoords);
    vec3 scene_position = texture(position_texture, TexCoords).xyz; 
    
	// 这里采用了画面每个点的世界坐标和相机的距离作为判定模糊的标准
	// 当然用深度信息也是可以的，性能上也更好，这里为了代码展示更好理解
    vec3 cam_pos = matrix_ubo.cam_pos.xyz;
	
    float blur_amout = smoothstep(min_dist, max_dist, abs(focus_distance - distance(scene_position, cam_pos)));
    
	// 最后的颜色是焦距内和散景的混合
    FragColor = mix(focus_color, out_of_focus_color, blur_amout);
}
```

这段代码理解起来应该没有什么太大的难度。

# 最终效果
这里展示一下最终的效果。

![近焦点](dof_near.png)
![远焦点](dof_far.png)

上面两张图分别展示了不同焦点的景深的表现结果。可以明显看到不同景深效果的加入可以很容易的将画面上想要着重表达出来的部分勾勒出来。优秀的散景效果也能给画面增加不少美感（虽然我这个测试场景也没有什么美感可言...）。