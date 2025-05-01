---
title: 级联阴影贴图实现
date: 2024-10-13 17:06:53
categories: 
	- 技术漫谈
tags: [3D, render, 渲染, 编程]
index_img: /2024/10/13/cascade-shadow-map/sm_far.png
banner_img: /2024/10/13/cascade-shadow-map/sm_far.png
---

## 阴影贴图的局限
阴影贴图（shadow map）是3D场景中实现阴影效果的基础手段，它通过预先将光线方向的场景深度存储到贴图中，在渲染的时候取每个场景中的点到光源的距离和深度贴图作比较，来判定该点是否在阴影当中。

但是在较大的场景中，使用阴影贴图会有几个明显的不足：

1. 阴影贴图只能覆盖部分场景，在渲染较大的场景的时候（如大世界），远处的场景基本上无法被阴影贴图所覆盖。
2. 贴图的分辨率是有限的，太大的分辨率会对性能造成非常大的影响。但是在覆盖较大场景的时候，贴图分辨率不足会导致阴影模糊，效果不佳。
3. 阴影贴图的实现一开始其实并没有考虑玩家相机的视椎体，也就是说在玩家没有看的地方也会渲染阴影贴图，这对渲染资源来说显然是个浪费。

KongEngine计划在后面接入大地形的渲染，借此机会接入了级联阴影贴图的能力。
实现方法参考了[LearnOpenGL的教程](https://learnopengl.com/Guest-Articles/2021/CSM)。


## 级联阴影贴图的实现
级联阴影贴图的基本概念包括如下几点：

1. 将玩家的视椎体划分为几段，每一段视椎体构建一张阴影贴图覆盖，这个阴影贴图完美贴合从光源方向投射到这段视椎体中心点的正交投影。
2. 和模型LOD的理念类似，离相机近的阴影贴图需要采用较高精度，而离相机远的阴影贴图可以使用低精度。
3. 将多级阴影贴图传入最后的光照计算着色器，根据每个点所处视椎体的分段不同采用对应不同的阴影贴图计算光照。

听起来挺简单的对吧，那我们一步一步来。

### 视椎体分段
上面说到我们需要将视椎体分为几段，在每一段视椎体覆盖一张阴影贴图，并计算出这张贴图的从光源方向看向视椎体中心点的正交投影的矩阵，也就是Light projection matrix和Light view matrix。这个矩阵需要紧密贴合这段视椎体，为此我们需要得到视椎体的顶点的世界坐标，得到顶点的min、max和视椎体的中心点。

我们从相机的视椎体出发，当处于视椎体范围上的顶点的世界坐标经过projection矩阵和view矩阵转换后，xyz都会被映射到[-1,1]范围的屏幕空间坐标。矩阵转换是可逆的，也就是说取屏幕空间坐标为[-1, 1]边界的八个顶点，经过视椎体的projection矩阵和view矩阵的逆矩阵转换后，就能得到边界顶点的世界空间坐标。在代码里面的实现如下：

```c++
std::vector<glm::vec4> CDirectionalLightComponent::GetFrustumCornersWorldSpace(const glm::mat4& proj_view)
{
    const auto inv = glm::inverse(proj_view);

    // 顶点的世界坐标在projection和view matrix的转换下的坐标范围是[-1,1]
    // 那么将在[-1,1]这个边界的八个顶点坐标乘以projection和view matrix的逆矩阵则可以得到视锥体边界的顶点的世界坐标
    vector<vec4> frustum_corners;
    for(unsigned int i = 0; i < 2; i++)
    {
        for(unsigned int j = 0; j < 2; j++)
        {
            for(unsigned int k = 0; k < 2; k++)
            {
                const vec4 pt = inv * vec4(2.0f*i-1.0f,2.0f*j-1.0f,2.0f*k-1.0f, 1.0f);
                frustum_corners.push_back(pt / pt.w);
            }
        }   
    }
    
    return frustum_corners;
}
```

我们得到了视椎体角落的顶点世界坐标，我们希望阴影贴图能够如下图一般贴合每一段视椎体。那么我们需要计算视椎体的中心顶点坐标，中心顶点在计算view矩阵的时候需要用到；我们需要计算在xyz轴上顶点坐标的最大和最小值，这些数值在计算projection矩阵的时候会被用到。

![级联阴影贴图由远及近](https://learnopengl.com/img/guest/2021/CSM/frustum_fitting.png)

计算中心点的代码十分简单，将视椎体角落的坐标相加后再除以数量即可，代码如下：

``` c++
vec3 center = vec3(0.0f);
for(const auto& v : corners)
{
    center += vec3(v);
}
center /= corners.size();   // 获取视锥体的中心点

const auto light_view = lookAt(center-light_dir, center, vec3(0.0f, 1.0f, 0.0f));
```

计算贴合视椎体的范围则是比较并记录各个顶点在xyz轴的最大值和最小值，方法如下。这里提一下在z轴方向和一个参数z_mult进行了处理，其意义是阴影的投射源是有可能在视椎体范围之外的，如果不考虑这一部分的影响的话可能在阴影过度的时候会非常生硬，并且丢掉一些本来该显示的阴影导致渲染错误。

``` c++
float min_x = std::numeric_limits<float>::max();
float min_y = std::numeric_limits<float>::max();
float min_z = std::numeric_limits<float>::max();
float max_x = std::numeric_limits<float>::lowest();
float max_y = std::numeric_limits<float>::lowest();
float max_z = std::numeric_limits<float>::lowest();
for (const auto& v : corners)
{
    const auto trf = light_view * v;
    min_x = std::min(min_x, trf.x);
    max_x = std::max(max_x, trf.x);
    min_y = std::min(min_y, trf.y);
    max_y = std::max(max_y, trf.y);
    min_z = std::min(min_z, trf.z);
    max_z = std::max(max_z, trf.z);
}
constexpr float z_mult = 10.0f;
if (min_z < 0)
{
    min_z *= z_mult;
}
else
{
    min_z /= z_mult;
}
if (max_z < 0)
{
    max_z /= z_mult;
}
else
{
    max_z *= z_mult;
}

const mat4 light_projection = ortho(min_x, max_x, min_y, max_y, min_z, max_z);
```

### 计算级联阴影贴图
一般的阴影贴图我们采用的是GL_TEXTURE_2D，而级联阴影贴图我们需要传入多张贴图，因此对应的贴图类型会变为GL_TEXTURE_2D_ARRAY。

``` c++
glGenTextures(1, &csm_texture);
glBindTexture(GL_TEXTURE_2D_ARRAY, csm_texture);
glTexImage3D(GL_TEXTURE_2D_ARRAY, 0, GL_DEPTH_COMPONENT32F, SHADOW_RESOLUTION, SHADOW_RESOLUTION, (int)csm_distances.size()+1, 0, GL_DEPTH_COMPONENT, GL_FLOAT, nullptr);
glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_BORDER);
glTexParameteri(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_BORDER);
glTexParameterfv(GL_TEXTURE_2D_ARRAY, GL_TEXTURE_BORDER_COLOR, border_color);

glBindFramebuffer(GL_FRAMEBUFFER, shadowmap_fbo);
glFramebufferTexture(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, csm_texture, 0);
glDrawBuffer(GL_NONE);
glReadBuffer(GL_NONE);
glBindFramebuffer(GL_FRAMEBUFFER, 0);
```

除此之外，我们需要一次性渲染多张贴图，我们参考点光源阴影贴图使用geometry shader的做法，将顶点映射到不同的视椎体分段的光源的投影。代码如下：

``` glsl
#version 450 compatibility
layout(triangles, invocations = 6) in;
layout(triangle_strip, max_vertices = 3) out;

uniform mat4 light_space_matrix[16];


void main()
{
	for (int i = 0; i < 3; ++i)
	{
		gl_Position = light_space_matrix[gl_InvocationID] * gl_in[i].gl_Position;
		gl_Layer = gl_InvocationID;
		EmitVertex();
	}
	EndPrimitive();
} 
```

这里新增的**invocations = 6**代表了这个Shader可以被实例化，每个实例同时平行进行运算，实例的个数为6。内置的**gl_InvocationID**代表了当前处理的是哪一个实例，我们将其赋值到**gl_Layer**。其余的阴影贴图渲染步骤和普通的阴影贴图类似。

下面几张图所示展示的，就是从近到远的几个级联阴影贴图的表现：
![](csm_near.png)
![](csm_mid.png)
![](csm_far.png)

### 使用级联阴影贴图
级联阴影贴图的使用和阴影贴图是类似的，由于传入给光照Shader的是GL_TEXTURE_2D_ARRAY，需要使用vec3来索引贴图数据的，vec3的z值代表的是Layer索引。

Layer代表的是使用哪一个视椎体分段的阴影贴图，取决于当前像素和相机的距离。取得对应的Layer参数后带入texcoord的z值读取对应的阴影贴图的值。示例代码如下：

``` glsl
// 计算阴影
float ShadowCalculation_DirLight(vec4 frag_world_pos, vec3 to_light_dir, vec3 in_normal)
{
    // 获取像素和相机的距离，也就是view转换后的z值
    vec4 frag_pos_view_space = matrix_ubo.view * frag_world_pos;
    float depthValue = abs(frag_pos_view_space.z);

    // 根据距离和每段视椎体分段的距离区间，获取Layer值
    int layer = -1;
    for (int i = 0; i < csm_level_count; ++i)
    {
        if (depthValue < csm_distances[i])
        {
            layer = i;
            break;
        }
    }
    if (layer == -1)
    {
        layer = csm_level_count;
    }
    // 下面的和应用普通阴影贴图的一致
    // 转换到-1,1的范围，再转到0,1的范围
    vec4 frag_pos_light_space = light_space_matrices[layer] * frag_world_pos;
    // perform perspective divide
    vec3 proj_coord = frag_pos_light_space.xyz / frag_pos_light_space.w;
    // transform to [0,1] range
    proj_coord = proj_coord * 0.5 + 0.5;

    // get depth of current fragment from light's perspective
    float current_depth = proj_coord.z;

    // keep the shadow at 0.0 when outside the far_plane region of the light's frustum.
    if (current_depth > 1.0)
    {
        return 0.0;
    }

    // PCF
    float shadow = 0.0;
    vec2 texel_size = 1.0 / vec2(textureSize(shadow_map, 0));
    for(int x = -1; x <= 1; ++x)
    {
        for(int y = -1; y <= 1; ++y)
        {
            float pcf_depth = texture(shadow_map, vec3(proj_coord.xy + vec2(x, y) * texel_size, layer)).r;
            shadow += current_depth > pcf_depth ? 1.0 : 0.0;
        }
    }
    shadow /= 9.0;
        
    return shadow;
}
```

## 效果对比
### 原先的阴影贴图
原先的阴影贴图只能覆盖有限的场景：
![](sm_near.png)

提升覆盖范围后，阴影的质量则会出现下降：
![](sm_far.png)

### 级联阴影贴图
采用级联阴影贴图可以覆盖很大的场景，并且在可控的性能消耗下仍然有不错的显示智联。
![](csm_result.png)
