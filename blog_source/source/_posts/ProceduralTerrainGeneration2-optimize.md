---
title: 程序化地形生成-2-性能优化
date: 2024-11-19 22:34:36
categories: 
	- 技术漫谈
tags: [3D, render, 渲染, 编程, 程序化生成]
	
---

## 性能优化的需求
自从实现了程序化地形生成的那个[ShaderToy上的Demo](https://www.shadertoy.com/view/4XByRV)之后，我对它的性能表现一直不太满意，随随便便跑一下我的GPU就直接拉到100%了，电脑风扇呼呼的。做了很多次大大小小的优化，最后发现瓶颈还是在对地形的光线步进计算上，不把这个问题解决掉的话这个场景的性能怎么样都无法达到令我满意的程度。

于是我一直在寻找类似的场景，寻找有什么光线步进的方法能够满足我的要求：首先它必须是要针对实时随机生成的地形，也就是说不能是针对高度图或者其他预处理过的地形数据；其次它需要快，至少能够在我这台笔记本上（3070ti显卡）能够保持50%以下的占用率；最后就是这个光线步进算法需要有一定的精度，但是要求不会很高。

最后我在ShaderToy上找到了一个非常棒的[例子](https://www.shadertoy.com/view/4slGD4)，来自Dave_Hoskins。

Dave的Demo也是做了地形的渲染，他的场景比我复杂很多，但是这个更为复杂的场景在我的电脑上运行的时候，它的GPU占用率（分辨率768X432）只有35%左右，远低于我的demo让我大为震撼。

于是我开始研究它的光线步进的逻辑，如下：
```glsl
// source:https://www.shadertoy.com/view/4slGD4
float BinarySubdivision(in vec3 rO, in vec3 rD, vec2 t)
{
	// Home in on the surface by dividing by two and split...
    float halfwayT;
  
    for (int i = 0; i < 5; i++)
    {

        halfwayT = dot(t, vec2(.5));
        vec3 p = rO + halfwayT*rD;
        float d = p.y - getTerrainHeight(p.xz, perlinOctaves); 
        // float d = Map(rO + halfwayT*rD); 
         t = mix(vec2(t.x, halfwayT), vec2(halfwayT, t.y), step(0.5, d));

    }
	return halfwayT;
}

bool rayMarchingTerrain(vec3 ro, vec3 rd, float max_dist, out float res_t)
{
    float t = 1. + Hash12(g_frag_coord)*1.;
	float oldT = 0.0;
	float delta = 0.0;
	bool fin = false;
	bool res = false;
	vec2 distances;
	for( int j=0; j< 150; j++ )
	{
		if (fin || t > 240.0) break;
		vec3 p = ro + t*rd;
		//if (t > 240.0 || p.y > 195.0) break;
		float h = p.y - getTerrainHeight(p.xz, perlinOctaves); // ...Get this positions height mapping.
		// Are we inside, and close enough to fudge a hit?...
		if( h < 0.5)
		{
			fin = true;
			distances = vec2(oldT, t);
			break;
		}
		// Delta ray advance - a fudge between the height returned
		// and the distance already travelled.
		// It's a really fiddly compromise between speed and accuracy
		// Too large a step and the tops of ridges get missed.
		delta = max(0.01, 0.3*h) + (t*0.0065);
		oldT = t;
		t += delta;
	}
	if (fin) res_t = BinarySubdivision(ro, rd, distances);

	return fin;
}
```

其实代码逻辑很简单，就是光线步进到的位置和当前XZ坐标的地形高度做比对，当光线步进的位置的高度和地形足够近的时候，记为击中。记录当前和上一步的t的位置，在得到最终结果的时候做一个取中间值的操作。

这个方法的精华部分是这个：**delta = max(0.01, 0.3\*h) + (t\*0.0065);**，它被用于计算光线步进下一步的距离。如果光线步进每一步距离太近，会严重影响性能；而如果一步太远，则会导致地形的精度不足，出现地表抖动甚至断裂的情况。

Dave的方法，结合了当前位置和地形的高度差h和光线步进已经经过的长度t。高度差越小，说明可能越接近地表，需要较小的步长（反之亦然）；t的影响则表示远处的地形的精度需求可以逐步降低。

下面是我原来的计算方式。
```glsl
bool rayMarchingTerrain(vec3 ro, vec3 rd, float max_dist, out float res_t)
{
    // float terrain_height = sin(iTime) + 1.;    
    float dt_min = 0.1f;
    float dt_max = 3.0f;

    float dt = 1.0;
    res_t = 0.0;
    // first pass, step 1
    for(float t = mint; t < max_dist; t+=dt)
    {
        vec3 p = ro+t*rd;
        float terrain_height = getTerrainHeight(p.xz, perlinOctaves);
        if(p.y < terrain_height )
        {        
            // res_t = t - dt + dt*(last_h - last_p.y) / (p.y - last_p.y-terrain_height+last_h); 
            res_t = t;
            break;
        }        
        // // closer terrain use higher accuracy        
        // last_h = terrain_height;        
        // last_p = p;
        dt = mix(dt_min, dt_max, pow(t / max_dist, 2.0));
    }

    // hit terrain
    if(res_t > 0.)
    {
        float last_h = 0.0;
        vec3 last_p = vec3(0);
        float mini_dt =  max(0.01, dt * 0.02);
        for(float t = res_t - dt; t < res_t + .01; t+=mini_dt)
        {
            vec3 p = ro+t*rd;
            float terrain_height = getTerrainHeight(p.xz, perlinOctaves);
            if(p.y < terrain_height)
            {        
                res_t = t - mini_dt + mini_dt*(last_h - last_p.y) / (p.y - last_p.y-terrain_height+last_h); 
                return true;
            }        
            // closer terrain use higher accuracy        
            last_h = terrain_height;        
            last_p = p;
        }
    }

    return false;    
}
```

我原来的方法的思想是做两遍测试，先以一个较大步长做一次初步筛选，找到大概的光线穿过地形的区间；然后再在那个区间用较小的步长做另外因此光线步进。

这个方法的问题在于如果初筛的时候步长太大，可能会穿过一个厚度较小的地形（比如说山峰），所以初筛的步长也不能太小；第二次筛选似乎取值也偏小了，导致还是做了很多次的光线步进检测。

## 优化结果
现在我将新的光线步进方法更新到了我原来的ShaderToy Demo上，在768X432的分辨率60fps的情况下，我的demo在我的电脑上的GPU占用率由80%左右降低到了35%左右，可谓是巨大的提升。

在demo的代码中，我在第一行添加了代码
```glsl
#define OLD_METHOD 0
```
将**OLD_METHOD**改为1的话可以改为使用老方法，各位有兴趣的话可以实际修改一下代码来对比一下这两种方法的性能差异。

