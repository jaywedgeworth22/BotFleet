import { MEMORY_BYTES, NANO_CPUS, PIDS_LIMIT, SHM_BYTES } from "./server/container-computer.ts";
const config = {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        RestartPolicy: { Name: "unless-stopped" },
        CgroupnsMode: "private",
        SecurityOpt: [],
};

const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
const capAdd = (config.CapAdd ?? [])
  .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
  .sort();

console.log("Memory:", config.Memory === MEMORY_BYTES);
console.log("MemorySwap:", (config.MemorySwap ?? 0) === MEMORY_BYTES);
console.log("NanoCpus:", (config.NanoCpus ?? 0) === NANO_CPUS);
console.log("PidsLimit:", config.PidsLimit === PIDS_LIMIT);
console.log("capDrop:", capDrop.includes("all"));
console.log("capAdd:", capAdd.join(",") === "setgid,setuid");
console.log("Privileged:", config.Privileged === false);
console.log("PidMode:", !config.PidMode);
console.log("IpcMode:", config.IpcMode === "private");
console.log("UTSMode:", !config.UTSMode);
console.log("ShmSize:", config.ShmSize === SHM_BYTES);
console.log("Devices:", (!config.Devices || config.Devices.length === 0));
console.log("DeviceRequests:", (!config.DeviceRequests || config.DeviceRequests.length === 0));
console.log("CgroupnsMode:", config.CgroupnsMode === "private");
