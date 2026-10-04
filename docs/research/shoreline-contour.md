# Shoreline contour

The river builder discarded an entire four-unit cell whenever one corner or its centre was dry. This made the waterline follow square grid boundaries and produced the visible teeth in the river and lake screenshots.

[GPU Gems 3 on isosurfaces](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu) generates boundary polygons in cells whose corner signs differ. [Research on grid-based shorelines](https://www.sciencedirect.com/science/article/abs/pii/S0021999104001871) similarly locates the waterline through interpolation between wet and dry corners. Roadcraft now retains the original two triangles for fully wet cells and clips only mixed cells, refining each crossing against its actual terrain sampler so the water does not hang above a nonlinear or stepped bank.
