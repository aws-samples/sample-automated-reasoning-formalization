import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import MiniCssExtractPlugin from "mini-css-extract-plugin";

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "mcp-server.js",
    },
    name: "ARchitect",
    executableName: "ARchitect",
    icon: "./icon/ARchitect",
    extraResource: ["./icon"],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({ options: { bin: "ARchitect" } }),
    new MakerRpm({ options: { bin: "ARchitect" } }),
  ],
  plugins: [
    new WebpackPlugin({
      mainConfig: {
        entry: {
          index: "./src/main.ts",
          "mcp-server": "./src/mcp-server-entry.ts",
        },
        output: {
          filename: "[name].js",
        },
        module: {
          rules: [
            {
              test: /\.tsx?$/,
              exclude: [/node_modules/, /\.test\.tsx?$/],
              use: { loader: "ts-loader" },
            },
            { test: /\.node$/, use: "node-loader" },
          ],
        },
        resolve: { extensions: [".js", ".ts", ".tsx", ".json"] },
      },
      renderer: {
        config: {
          devtool: "source-map",
          module: {
            rules: [
              {
                test: /\.tsx?$/,
                exclude: [/node_modules/, /\.test\.tsx?$/],
                use: { loader: "ts-loader" },
              },
              // App styles — excludes Cloudscape (split for future CSS module/scoping config)
              {
                test: /\.css$/,
                exclude: /node_modules\/@cloudscape-design\//,
                use: [MiniCssExtractPlugin.loader, "css-loader"],
              },
              // Cloudscape styles — separated so we can add CSS modules or scoping later
              {
                test: /\.css$/,
                include: /node_modules\/@cloudscape-design\//,
                use: [MiniCssExtractPlugin.loader, "css-loader"],
              },
            ],
          },
          plugins: [new MiniCssExtractPlugin()],
          resolve: { extensions: [".js", ".ts", ".tsx", ".css"] },
        },
        entryPoints: [
          {
            html: "./src/index.html",
            js: "./src/renderer.ts",
            name: "main_window",
            preload: { js: "./src/preload.ts" },
          },
        ],
      },
    }),
  ],
};

export default config;
