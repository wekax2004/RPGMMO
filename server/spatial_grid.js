/**
 * Spatial Grid for Area-of-Interest (AoI) processing.
 * Divides the map into chunks to efficiently query nearby entities.
 */

const CHUNK_SIZE = 400; // Size of each chunk in pixels

class SpatialGrid {
    constructor(mapWidth, mapHeight) {
        this.cols = Math.ceil(mapWidth / CHUNK_SIZE);
        this.rows = Math.ceil(mapHeight / CHUNK_SIZE);
        this.grid = new Map(); // "x,y" -> Set of entity IDs
        this.entityLocations = new Map(); // entityId -> {cx, cy}
    }

    _getChunkCoords(x, y) {
        return {
            cx: Math.floor(x / CHUNK_SIZE),
            cy: Math.floor(y / CHUNK_SIZE)
        };
    }

    _getChunkKey(cx, cy) {
        return `${cx},${cy}`;
    }

    addEntity(id, x, y) {
        const { cx, cy } = this._getChunkCoords(x, y);
        const key = this._getChunkKey(cx, cy);
        
        if (!this.grid.has(key)) {
            this.grid.set(key, new Set());
        }
        this.grid.get(key).add(id);
        this.entityLocations.set(id, { cx, cy });
    }

    updateEntity(id, x, y) {
        const newCoords = this._getChunkCoords(x, y);
        const oldCoords = this.entityLocations.get(id);

        if (!oldCoords) {
            this.addEntity(id, x, y);
            return;
        }

        if (newCoords.cx !== oldCoords.cx || newCoords.cy !== oldCoords.cy) {
            // Move to new chunk
            const oldKey = this._getChunkKey(oldCoords.cx, oldCoords.cy);
            const oldSet = this.grid.get(oldKey);
            if (oldSet) oldSet.delete(id);

            const newKey = this._getChunkKey(newCoords.cx, newCoords.cy);
            if (!this.grid.has(newKey)) {
                this.grid.set(newKey, new Set());
            }
            this.grid.get(newKey).add(id);
            this.entityLocations.set(id, newCoords);
        }
    }

    removeEntity(id) {
        const coords = this.entityLocations.get(id);
        if (coords) {
            const key = this._getChunkKey(coords.cx, coords.cy);
            const set = this.grid.get(key);
            if (set) set.delete(id);
            this.entityLocations.delete(id);
        }
    }

    /**
     * Returns a set of all entity IDs within the adjacent chunks (3x3 grid)
     */
    getEntitiesNearby(x, y) {
        const { cx, cy } = this._getChunkCoords(x, y);
        const nearby = new Set();

        for (let i = -1; i <= 1; i++) {
            for (let j = -1; j <= 1; j++) {
                const key = this._getChunkKey(cx + i, cy + j);
                const chunk = this.grid.get(key);
                if (chunk) {
                    for (const id of chunk) {
                        nearby.add(id);
                    }
                }
            }
        }
        return nearby;
    }
}

module.exports = SpatialGrid;
