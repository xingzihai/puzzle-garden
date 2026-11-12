# 构件 API 说明（自动生成，状态见各节）

## plinth

台基：承托轮廓向四边外挑，顶部可承托外墙。

状态：offline-pass

```json
{
  "description": "台基：承托轮廓向四边外挑，顶部可承托外墙。",
  "type": "object",
  "properties": {
    "footprint": {
      "anyOf": [
        {
          "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
          "x-opaque": "Footprint"
        },
        {
          "type": "object",
          "properties": {
            "points": {
              "minItems": 3,
              "type": "array",
              "items": {
                "type": "array",
                "prefixItems": [
                  {
                    "type": "integer",
                    "minimum": -33554432,
                    "maximum": 33554431
                  },
                  {
                    "type": "integer",
                    "minimum": -33554432,
                    "maximum": 33554431
                  }
                ],
                "items": false,
                "minItems": 2,
                "maxItems": 2
              }
            }
          },
          "required": ["points"]
        }
      ],
      "description": "承托轮廓（外墙或柱落在其上），不含外挑；手写用 rect 或 { points }"
    },
    "under": {
      "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
      "x-opaque": "Surface"
    },
    "y": {
      "default": 1,
      "type": "integer",
      "minimum": -2048,
      "maximum": 2047
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "project": {
      "default": 0,
      "description": "向四边外挑的格数",
      "type": "integer",
      "minimum": 0
    },
    "material": {
      "type": "string"
    }
  },
  "required": ["height", "material"]
}
```

## walls

外墙：只写墙厚，内部留空；返回立面与墙顶。

状态：offline-pass

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "on": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "墙厚，向内长；footprint 是外轮廓"
        },
        "material": {
          "type": "string"
        },
        "outline": {
          "default": "rect",
          "type": "string",
          "enum": ["rect", "apse"]
        },
        "bands": {
          "default": [],
          "description": "从墙底 0 起算的闭区间换材质，区间互不重叠",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "material": {
                "type": "string"
              }
            },
            "required": ["from", "to", "material"]
          }
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": ["on", "material", "height"]
    },
    {
      "type": "object",
      "properties": {
        "on": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "墙厚，向内长；footprint 是外轮廓"
        },
        "material": {
          "type": "string"
        },
        "outline": {
          "default": "rect",
          "type": "string",
          "enum": ["rect", "apse"]
        },
        "bands": {
          "default": [],
          "description": "从墙底 0 起算的闭区间换材质，区间互不重叠",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "material": {
                "type": "string"
              }
            },
            "required": ["from", "to", "material"]
          }
        },
        "storeys": {
          "description": "楼层：层数 × 层高（层高 ≥ 4，为一格楼板与通行净空留空间）",
          "type": "object",
          "properties": {
            "count": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "height": {
              "type": "integer",
              "minimum": 4
            }
          },
          "required": ["count", "height"]
        }
      },
      "required": ["on", "material", "storeys"]
    },
    {
      "type": "object",
      "properties": {
        "footprint": {
          "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
          "x-opaque": "Footprint"
        },
        "y": {
          "type": "integer",
          "minimum": -2048,
          "maximum": 2047
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "墙厚，向内长；footprint 是外轮廓"
        },
        "material": {
          "type": "string"
        },
        "outline": {
          "default": "rect",
          "type": "string",
          "enum": ["rect", "apse"]
        },
        "bands": {
          "default": [],
          "description": "从墙底 0 起算的闭区间换材质，区间互不重叠",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "material": {
                "type": "string"
              }
            },
            "required": ["from", "to", "material"]
          }
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": ["footprint", "y", "material", "height"]
    },
    {
      "type": "object",
      "properties": {
        "footprint": {
          "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
          "x-opaque": "Footprint"
        },
        "y": {
          "type": "integer",
          "minimum": -2048,
          "maximum": 2047
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "墙厚，向内长；footprint 是外轮廓"
        },
        "material": {
          "type": "string"
        },
        "outline": {
          "default": "rect",
          "type": "string",
          "enum": ["rect", "apse"]
        },
        "bands": {
          "default": [],
          "description": "从墙底 0 起算的闭区间换材质，区间互不重叠",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "from": {
                "type": "integer",
                "minimum": 0
              },
              "to": {
                "type": "integer",
                "minimum": 0
              },
              "material": {
                "type": "string"
              }
            },
            "required": ["from", "to", "material"]
          }
        },
        "storeys": {
          "description": "楼层：层数 × 层高（层高 ≥ 4，为一格楼板与通行净空留空间）",
          "type": "object",
          "properties": {
            "count": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "height": {
              "type": "integer",
              "minimum": 4
            }
          },
          "required": ["count", "height"]
        }
      },
      "required": ["footprint", "y", "material", "storeys"]
    }
  ],
  "description": "外墙：只写墙厚，内部留空；返回立面与墙顶。"
}
```

## opening

开洞：贯穿墙厚，优先于结构，门框不会堵住通道。

状态：offline-pass

```json
{
  "description": "开洞：贯穿墙厚，优先于结构，门框不会堵住通道。",
  "type": "object",
  "properties": {
    "in": {
      "description": "立面锚点：只能使用当前世界构件返回的立面，如 hall.facade('north')、base.edge('south')。",
      "x-opaque": "Facade"
    },
    "kind": {
      "type": "string",
      "enum": ["door", "window", "gate"]
    },
    "shape": {
      "default": "rect",
      "type": "string",
      "enum": ["rect", "arch", "pointed", "round"]
    },
    "width": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "description": "洞的净宽，不含框"
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "description": "洞的净高，不含框"
    },
    "sill": {
      "default": 0,
      "description": "洞底距站立面的格数：普通外墙从墙底算；repeat.storeys 时从该层楼板顶面（楼板厚 1）算",
      "type": "integer",
      "minimum": 0
    },
    "storey": {
      "description": "需 storeys；与 repeat.storeys 互斥",
      "type": "integer",
      "minimum": 0
    },
    "at": {
      "default": 0,
      "description": "洞中心相对立面中点的偏移：南北立面 +x、东西立面 +z 为正",
      "type": "integer"
    },
    "fill": {
      "default": "air",
      "description": "洞内填充（玻璃、门等）；填了就不能接踏步",
      "type": "string"
    },
    "repeat": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "every": {
              "type": "integer",
              "exclusiveMinimum": 0
            }
          },
          "required": ["every"]
        },
        {
          "type": "object",
          "properties": {
            "storeys": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "integer",
                "minimum": 0
              }
            }
          },
          "required": ["storeys"]
        }
      ]
    },
    "canopy": {
      "description": "洞顶外挑的雨棚：depth 为向外伸出的格数，只覆盖本洞宽度",
      "type": "object",
      "properties": {
        "depth": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["depth", "material"]
    },
    "frame": {
      "description": "外侧一圈框：默认宽 1，会凸出墙外 1 格",
      "type": "object",
      "properties": {
        "width": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["material"]
    },
    "mullion": {
      "description": "只用于矩形窗；width = k·every + 1",
      "type": "object",
      "properties": {
        "every": {
          "default": 2,
          "type": "integer",
          "minimum": 2
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["material"]
    }
  },
  "required": ["in", "kind", "width", "height"]
}
```

## floorPlate

楼板：在内部区域或楼层锚点铺板，梯孔由楼梯自动开通。

状态：offline-pass

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "in": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["in", "material"]
    },
    {
      "type": "object",
      "properties": {
        "footprint": {
          "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
          "x-opaque": "Footprint"
        },
        "y": {
          "type": "integer",
          "minimum": -2048,
          "maximum": 2047
        },
        "thickness": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["footprint", "y", "material"]
    }
  ],
  "description": "楼板：在内部区域或楼层锚点铺板，梯孔由楼梯自动开通。"
}
```

## stair

楼梯：连接两个表面，自动设置楼梯朝向并保留踏面与头顶净空。

状态：offline-pass

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "from": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "to": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "at": {
          "description": "首级格，也是该跑中线",
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            },
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            }
          ],
          "items": false,
          "minItems": 2,
          "maxItems": 2
        },
        "facing": {
          "default": "east",
          "description": "上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧",
          "type": "string",
          "enum": ["north", "south", "east", "west"]
        },
        "material": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "const": "straight"
        },
        "width": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": ["from", "to", "at", "material", "kind"]
    },
    {
      "type": "object",
      "properties": {
        "from": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "to": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "at": {
          "description": "首级格，也是该跑中线",
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            },
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            }
          ],
          "items": false,
          "minItems": 2,
          "maxItems": 2
        },
        "facing": {
          "default": "east",
          "description": "上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧",
          "type": "string",
          "enum": ["north", "south", "east", "west"]
        },
        "material": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "const": "switchback"
        },
        "width": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        }
      },
      "required": ["from", "to", "at", "material", "kind"]
    },
    {
      "type": "object",
      "properties": {
        "from": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "to": {
          "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
          "x-opaque": "Surface"
        },
        "at": {
          "description": "首级格，也是该跑中线",
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            },
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            }
          ],
          "items": false,
          "minItems": 2,
          "maxItems": 2
        },
        "facing": {
          "default": "east",
          "description": "上楼方向，入口在首级反方向一格；switchback 第二跑在南北朝向的 +x 侧、东西朝向的 +z 侧",
          "type": "string",
          "enum": ["north", "south", "east", "west"]
        },
        "material": {
          "type": "string"
        },
        "kind": {
          "type": "string",
          "const": "spiral"
        },
        "radius": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "description": "方形螺旋半径，at 为中心"
        }
      },
      "required": ["from", "to", "at", "material", "kind", "radius"]
    }
  ],
  "description": "楼梯：连接两个表面，自动设置楼梯朝向并保留踏面与头顶净空。"
}
```

## steps

踏步：从地表走到门洞或台基边，自动设置朝向并接齐入口。

状态：offline-pass

```json
{
  "description": "踏步：从地表走到门洞或台基边，自动设置朝向并接齐入口。",
  "type": "object",
  "properties": {
    "to": {
      "description": "洞口或入口锚点：只能使用当前世界构件返回的门洞、院门或台基边，如 hall.facade('north').opening(0)、court.gate。",
      "x-opaque": "Opening"
    },
    "width": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "material": {
      "type": "string"
    }
  },
  "required": ["to", "width", "material"]
}
```

## roof

屋面：默认竖向一格薄壳与一圈檐口，平屋面可承托上方体块。

状态：offline-pass

```json
{
  "description": "屋面：默认竖向一格薄壳与一圈檐口，平屋面可承托上方体块。",
  "type": "object",
  "properties": {
    "on": {
      "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
      "x-opaque": "Surface"
    },
    "footprint": {
      "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
      "x-opaque": "Footprint"
    },
    "y": {
      "type": "integer",
      "minimum": -2048,
      "maximum": 2047
    },
    "kind": {
      "type": "string",
      "enum": ["gable", "hip", "pyramid", "shed", "flat"]
    },
    "ridge": {
      "description": "屋脊方向；shed 高侧在 ridge x 的 +z 侧、ridge z 的 +x 侧",
      "type": "string",
      "enum": ["x", "z"]
    },
    "high": {
      "description": "单坡高侧所在边；与 ridge 二选一",
      "type": "string",
      "enum": ["north", "south", "east", "west"]
    },
    "pitch": {
      "description": "每内缩一格升高 pitch 格；与 peakY 二选一",
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 8
    },
    "peakY": {
      "description": "直接给尖顶 y；与 pitch 二选一",
      "type": "integer",
      "minimum": -2048,
      "maximum": 2047
    },
    "overhang": {
      "default": 1,
      "description": "出檐圈数，檐口保持承托面高度",
      "type": "integer",
      "minimum": 0
    },
    "thickness": {
      "default": 1,
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "parapet": {
      "description": "仅平屋面；会返回可站立的 top",
      "type": "object",
      "properties": {
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["height", "material"]
    },
    "finial": {
      "type": "object",
      "properties": {
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["height", "material"]
    },
    "gableMaterial": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "boolean",
          "const": false
        }
      ]
    },
    "material": {
      "type": "string"
    }
  },
  "required": ["kind", "material"]
}
```

## colonnade

柱廊：矩形轮廓四角起柱，按间距或总根数布柱，默认带额枋。

状态：offline-pass

```json
{
  "description": "柱廊：矩形轮廓四角起柱，按间距或总根数布柱，默认带额枋。",
  "type": "object",
  "properties": {
    "on": {
      "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
      "x-opaque": "Surface"
    },
    "footprint": {
      "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
      "x-opaque": "Footprint"
    },
    "y": {
      "type": "integer",
      "minimum": -2048,
      "maximum": 2047
    },
    "spacing": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "count": {
      "type": "integer",
      "minimum": 4
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "column": {
      "type": "object",
      "properties": {
        "width": {
          "default": 1,
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        },
        "shape": {
          "default": "square",
          "description": "cross：方芯四面各加一格；柱芯间距至少 w+3",
          "type": "string",
          "enum": ["square", "cross"]
        }
      },
      "required": ["material"]
    },
    "beam": {
      "anyOf": [
        {
          "type": "boolean",
          "const": false
        },
        {
          "type": "object",
          "properties": {
            "height": {
              "default": 1,
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "material": {
              "type": "string"
            }
          },
          "required": ["material"]
        }
      ]
    }
  },
  "required": ["height", "column"]
}
```

## rail

栏杆：沿平台外缘一次围合；门洞与梯道的开洞层自动保留通路。

状态：offline-pass

```json
{
  "description": "栏杆：沿平台外缘一次围合；门洞与梯道的开洞层自动保留通路。",
  "type": "object",
  "properties": {
    "along": {
      "description": "表面锚点：只能使用当前世界构件返回的句柄或其锚点，如 base.top、hall.storey(1)。",
      "x-opaque": "Surface"
    },
    "height": {
      "default": 1,
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "material": {
      "type": "string"
    },
    "gaps": {
      "default": [],
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "side": {
            "type": "string",
            "enum": ["north", "south", "east", "west"]
          },
          "at": {
            "default": 0,
            "type": "integer"
          },
          "width": {
            "type": "integer",
            "exclusiveMinimum": 0
          }
        },
        "required": ["side", "width"]
      }
    }
  },
  "required": ["along", "material"]
}
```

## enclosure

院墙：围合院落并贯通门洞，可包含整段挖通的门楼。

状态：offline-pass

```json
{
  "description": "院墙：围合院落并贯通门洞，可包含整段挖通的门楼。",
  "type": "object",
  "properties": {
    "outline": {
      "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
      "x-opaque": "Footprint"
    },
    "y": {
      "default": 1,
      "type": "integer",
      "minimum": -2048,
      "maximum": 2047
    },
    "height": {
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "thickness": {
      "default": 1,
      "type": "integer",
      "exclusiveMinimum": 0
    },
    "material": {
      "type": "string"
    },
    "gate": {
      "type": "object",
      "properties": {
        "side": {
          "type": "string",
          "enum": ["north", "south", "east", "west"]
        },
        "at": {
          "default": 0,
          "type": "integer"
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "height": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "gatehouse": {
          "type": "object",
          "properties": {
            "depth": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "width": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "height": {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            "material": {
              "type": "string"
            },
            "outward": {
              "default": 0,
              "description": "伸出院墙外，上限 depth − thickness",
              "type": "integer",
              "minimum": 0
            }
          },
          "required": ["depth", "width", "height", "material"]
        }
      },
      "required": ["side", "width", "height"]
    }
  },
  "required": ["outline", "height", "material", "gate"]
}
```

## paving

铺装：从入口向外铺指定长度、连接另一个入口，或整片铺满矩形，铺在 y=1。

状态：offline-pass

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "from": {
          "description": "洞口或入口锚点：只能使用当前世界构件返回的门洞、院门或台基边，如 hall.facade('north').opening(0)、court.gate。",
          "x-opaque": "Opening"
        },
        "to": {
          "anyOf": [
            {
              "type": "integer",
              "exclusiveMinimum": 0
            },
            {
              "description": "洞口或入口锚点：只能使用当前世界构件返回的门洞、院门或台基边，如 hall.facade('north').opening(0)、court.gate。",
              "x-opaque": "Opening"
            }
          ]
        },
        "width": {
          "type": "integer",
          "exclusiveMinimum": 0
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["from", "to", "width", "material"]
    },
    {
      "type": "object",
      "properties": {
        "region": {
          "description": "占地轮廓：手写时用 rect(minX, minZ, maxX, maxZ) 或 { points: [[x, z], …] }，也可直接用当前世界句柄或锚点上的 footprint。",
          "x-opaque": "Footprint"
        },
        "material": {
          "type": "string"
        }
      },
      "required": ["region", "material"]
    }
  ],
  "description": "铺装：从入口向外铺指定长度、连接另一个入口，或整片铺满矩形，铺在 y=1。"
}
```

## massingImport

草模导入：把 massing 工具返回的文档 id 体素化并入当前建筑；任一格 y<1 整次拒绝。id 来自 massing 工具（先登记再引用，不认识的 id 报 asset-missing）；at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270；材质优先级 materials[部件id] > material > 部件自带 material > 按 role+颜色取默认映射。

状态：offline-pass

```json
{
  "description": "草模导入：把 massing 工具返回的文档 id 体素化并入当前建筑；任一格 y<1 整次拒绝。id 来自 massing 工具（先登记再引用，不认识的 id 报 asset-missing）；at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270；材质优先级 materials[部件id] > material > 部件自带 material > 按 role+颜色取默认映射。",
  "type": "object",
  "properties": {
    "at": {
      "default": [0, 1, 0],
      "description": "草模原点（文档 y=0 平面）落在的世界格；默认 [0, 1, 0]",
      "type": "array",
      "prefixItems": [
        {
          "type": "integer",
          "minimum": -33554432,
          "maximum": 33554431
        },
        {
          "type": "integer",
          "minimum": -2048,
          "maximum": 2047
        },
        {
          "type": "integer",
          "minimum": -33554432,
          "maximum": 33554431
        }
      ],
      "items": false,
      "minItems": 3,
      "maxItems": 3
    },
    "rotate": {
      "default": 0,
      "description": "绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270",
      "anyOf": [
        {
          "type": "number",
          "const": 0
        },
        {
          "type": "number",
          "const": 90
        },
        {
          "type": "number",
          "const": 180
        },
        {
          "type": "number",
          "const": 270
        }
      ]
    },
    "mode": {
      "description": "整次导入的体素模式；缺省按部件 role（roof 为 shell，其余 solid）",
      "type": "string",
      "enum": ["shell", "solid"]
    },
    "thickness": {
      "description": "壳模式厚度 1–4（默认 1）；对 solid 部件传会报错",
      "type": "integer",
      "minimum": 1,
      "maximum": 4
    },
    "material": {
      "description": "整次统一的方块材质；优先于部件自带 material",
      "type": "string"
    },
    "materials": {
      "description": "按部件 id 覆盖材质；优先于 material，键必须是文档里的部件 id",
      "type": "object",
      "propertyNames": {
        "type": "string"
      }
    },
    "cleanup": {
      "description": "孤立格清理；默认 isolated",
      "type": "string",
      "enum": ["isolated", "none"]
    }
  }
}
```

## surfaceShell

参数化壳：kind:"surface" 写 position 公式、kind:"revolve" 写 profile 母线；采样后体素化并入建筑，写结构层。at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270，任一格 y<1 或越界整次拒绝；solid:true 填充内部（开放壳回退为壳并在句柄 leaky 标出）；一次调用一个部件，来源 api=surfaceShell。

状态：offline-pass

```json
{
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "const": "surface"
        },
        "position": {
          "x-function": "(u: number, v: number) => readonly [number, number, number]",
          "description": "参数曲面 (u: number, v: number) => readonly [x, y, z]；u、v ∈ [0, 1]"
        },
        "uSegments": {
          "default": 32,
          "description": "u 方向采样段数（4–128）",
          "type": "integer",
          "minimum": 4,
          "maximum": 128
        },
        "vSegments": {
          "default": 32,
          "description": "v 方向采样段数（4–128）",
          "type": "integer",
          "minimum": 4,
          "maximum": 128
        },
        "closedU": {
          "default": false,
          "description": "true 时 u 方向首尾无缝（不复制缝合列）",
          "type": "boolean"
        },
        "at": {
          "default": [0, 1, 0],
          "description": "局部原点（公式 y=0 平面）落在的世界格；默认 [0, 1, 0]（贴地表）",
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            },
            {
              "type": "integer",
              "minimum": -2048,
              "maximum": 2047
            },
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            }
          ],
          "items": false,
          "minItems": 3,
          "maxItems": 3
        },
        "rotate": {
          "default": 0,
          "description": "绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270",
          "anyOf": [
            {
              "type": "number",
              "const": 0
            },
            {
              "type": "number",
              "const": 90
            },
            {
              "type": "number",
              "const": 180
            },
            {
              "type": "number",
              "const": 270
            }
          ]
        },
        "transform": {
          "description": "建模变换（Euler XYZ 弧度、缩放各轴 >0）：体素化前作用于采样网格；与格旋转 rotate 相互独立",
          "type": "object",
          "properties": {
            "translate": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            },
            "rotate": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            },
            "scale": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            }
          }
        },
        "thickness": {
          "description": "壳厚 1–4 格；solid:true 时不能传",
          "type": "integer",
          "minimum": 1,
          "maximum": 4
        },
        "solid": {
          "default": false,
          "description": "false＝壳（默认）；true＝表壳＋内部填充，开放壳回退为壳并在句柄标 leaky",
          "type": "boolean"
        },
        "material": {
          "type": "string",
          "description": "结构层方块材质（必填）；未知方块与空气报 material-invalid"
        },
        "name": {
          "description": "部件名；缺省 surfaceShell",
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "cleanup": {
          "description": "孤立格清理；默认 isolated",
          "type": "string",
          "enum": ["isolated", "none"]
        }
      },
      "required": ["kind", "position", "material"]
    },
    {
      "type": "object",
      "properties": {
        "kind": {
          "type": "string",
          "const": "revolve"
        },
        "profile": {
          "x-function": "(t: number) => readonly [number, number]",
          "description": "旋转母线 (t: number) => readonly [radius, height]；绕局部 +y，t ∈ [0, 1]"
        },
        "profileSegments": {
          "default": 32,
          "description": "母线采样段数（4–128）",
          "type": "integer",
          "minimum": 4,
          "maximum": 128
        },
        "radialSegments": {
          "default": 48,
          "description": "环向采样段数（4–128）",
          "type": "integer",
          "minimum": 4,
          "maximum": 128
        },
        "at": {
          "default": [0, 1, 0],
          "description": "局部原点（公式 y=0 平面）落在的世界格；默认 [0, 1, 0]（贴地表）",
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            },
            {
              "type": "integer",
              "minimum": -2048,
              "maximum": 2047
            },
            {
              "type": "integer",
              "minimum": -33554432,
              "maximum": 33554431
            }
          ],
          "items": false,
          "minItems": 3,
          "maxItems": 3
        },
        "rotate": {
          "default": 0,
          "description": "绕 y 逆时针旋转的角度；只接受 0 / 90 / 180 / 270",
          "anyOf": [
            {
              "type": "number",
              "const": 0
            },
            {
              "type": "number",
              "const": 90
            },
            {
              "type": "number",
              "const": 180
            },
            {
              "type": "number",
              "const": 270
            }
          ]
        },
        "transform": {
          "description": "建模变换（Euler XYZ 弧度、缩放各轴 >0）：体素化前作用于采样网格；与格旋转 rotate 相互独立",
          "type": "object",
          "properties": {
            "translate": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            },
            "rotate": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            },
            "scale": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "number"
                },
                {
                  "type": "number"
                },
                {
                  "type": "number"
                }
              ],
              "items": false,
              "minItems": 3,
              "maxItems": 3
            }
          }
        },
        "thickness": {
          "description": "壳厚 1–4 格；solid:true 时不能传",
          "type": "integer",
          "minimum": 1,
          "maximum": 4
        },
        "solid": {
          "default": false,
          "description": "false＝壳（默认）；true＝表壳＋内部填充，开放壳回退为壳并在句柄标 leaky",
          "type": "boolean"
        },
        "material": {
          "type": "string",
          "description": "结构层方块材质（必填）；未知方块与空气报 material-invalid"
        },
        "name": {
          "description": "部件名；缺省 surfaceShell",
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "cleanup": {
          "description": "孤立格清理；默认 isolated",
          "type": "string",
          "enum": ["isolated", "none"]
        }
      },
      "required": ["kind", "profile", "material"]
    }
  ],
  "description": "参数化壳：kind:\"surface\" 写 position 公式、kind:\"revolve\" 写 profile 母线；采样后体素化并入建筑，写结构层。at 默认 [0, 1, 0]，rotate 只接受 0/90/180/270，任一格 y<1 或越界整次拒绝；solid:true 填充内部（开放壳回退为壳并在句柄 leaky 标出）；一次调用一个部件，来源 api=surfaceShell。"
}
```
