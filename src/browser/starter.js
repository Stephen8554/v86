"use strict";

/** 
 * Constructor for emulator instances.
 *
 * Usage: `var emulator = new V86Starter(options);`
 *
 * Options can have the following properties (all optional, default in parenthesis):
 *
 * - `memory_size number` (16 * 1024 * 1024) - The memory size in bytes, should
 *   be a power of 2.
 * - `vga_memory_size number` (8 * 1024 * 1024) - VGA memory size in bytes.
 *
 * - `autostart boolean` (false) - If emulation should be started when emulator
 *   is ready.
 *
 * - `disable_keyboard boolean` (false) - If the keyboard should be disabled.
 * - `disable_mouse boolean` (false) - If the mouse should be disabled.
 *
 * - `network_relay_url string` (No network card) - The url of a server running
 *   websockproxy. See [networking.md](networking.md). Setting this will
 *   enable an emulated network card.
 *
 * - `bios Object` (No bios) - Either a url pointing to a bios or an
 *   ArrayBuffer, see below.
 * - `vga_bios Object` (No VGA bios) - VGA bios, see below.
 * - `hda Object` (No hard drive) - First hard disk, see below.
 * - `fda Object` (No floppy disk) - First floppy disk, see below.
 * - `cdrom Object` (No CD) - See below.
 * - `initial_state Object` (Normal boot) - An initial state to load, see
 *   [`restore_state`](#restore_statearraybuffer-state) and below.
 *
 * - `filesystem Object` (No 9p filesystem) - A 9p filesystem, see
 *   [filesystem.md](filesystem.md).
 *
 * - `serial_container HTMLTextAreaElement` (No serial terminal) - A textarea
 *   that will receive and send data to the emulated serial terminal.
 *   Alternatively the serial terminal can also be accessed programatically,
 *   see [serial.html](samples/serial.html).
 *
 * - `screen_container HTMLElement` (No screen) - An HTMLElement. This should
 *   have a certain structure, see [basic.html](samples/basic.html).
 *
 * ***
 *
 * There are two ways to load images (`bios`, `vga_bios`, `cdrom`, `hda`, ...):
 *
 * - Pass an object that has a url. Optionally, `async: true` and `size:
 *   size_in_bytes` can be added to the object, so that sectors of the image
 *   are loaded on demand instead of being loaded before boot (slower, but
 *   strongly recommended for big files). In that case, the `Range: bytes=...`
 *   header must be supported on the server.
 *
 *   ```javascript
 *   // download file before boot
 *   options.bios = { 
 *       url: "bios/seabios.bin" 
 *   }
 *   // download file sectors as requested, size is required
 *   options.hda = { 
 *       url: "disk/linux.iso",
 *       async: true,
 *       size: 16 * 1024 * 1024 
 *   }
 *   ```
 *
 * - Pass an `ArrayBuffer` or `File` object as `buffer` property.
 *
 *   ```javascript
 *   // use <input type=file>
 *   options.bios = { 
 *       buffer: document.all.hd_image.files[0]
 *   }
 *   // start with empty hard drive
 *   options.hda = { 
 *       buffer: new ArrayBuffer(16 * 1024 * 1024)
 *   }
 *   ```
 *
 * ***
 *
 * @param {Object} options Options to initialize the emulator with.
 * @constructor 
 */
function V86Starter(options)
{
    var bus = Bus.create();
    var adapter_bus = this.bus = bus[0];

    this.emulator_bus = bus[1];

    var emulator = this.v86 = new v86(bus[1]);

    var settings = {};

    settings.load_devices = true;
    settings.memory_size = options["memory_size"] || 64 * 1024 * 1024;
    settings.vga_memory_size = options["vga_memory_size"] || 8 * 1024 * 1024;
    settings.boot_order = options["boot_order"] || 0x213;
    settings.fda = undefined;
    settings.fdb = undefined;

    if(options["network_relay_url"])
    {
        this.network_adapter = new NetworkAdapter(options["network_relay_url"], adapter_bus);
        settings.enable_ne2k = true;
    }

    if(!options["disable_keyboard"])
    {
        this.keyboard_adapter = new KeyboardAdapter(adapter_bus);
    }
    if(!options["disable_mouse"])
    {
        this.mouse_adapter = new MouseAdapter(adapter_bus);
    }

    if(options["screen_container"])
    {
        this.screen_adapter = new ScreenAdapter(options["screen_container"], adapter_bus);
    }

    if(options["serial_container"])
    {
        this.serial_adapter = new SerialAdapter(options["serial_container"], adapter_bus);
    }
    

    // ugly, but required for closure compiler compilation
    function put_on_settings(name, buffer)
    {
        switch(name)
        {
            case "hda":
                settings.hda = buffer;
                break;
            case "hdb":
                settings.hdb = buffer;
                break;
            case "cdrom":
                settings.cdrom = buffer;
                break;
            case "fda":
                settings.fda = buffer;
                break;
            case "fdb":
                settings.fdb = buffer;
                break;

            case "bios":
                settings.bios = buffer.buffer;
                break;
            case "vga_bios":
                settings.vga_bios = buffer.buffer;
                break;
            case "initial_state":
                settings.initial_state = buffer.buffer;
                break;
            case "fs9p_json":
                settings.fs9p_json = buffer.buffer;
                break;
            default:
                dbg_assert(false, name);
        }
    }

    var files_to_load = [];

    function add_file(name, file)
    {
        if(!file)
        {
            return;
        }

        // Anything coming from the outside world needs to be quoted for
        // Closure Compiler compilation
        file = {
            buffer: file["buffer"],
            async: file["async"],
            url: file["url"],
            size: file["size"],
        };

        if(name === "bios" || name === "vga_bios" || name === "initial_state")
        {
            // Ignore async for these because they must be availabe before boot.
            // This should make result.buffer available after the object is loaded
            file.async = false;
        }

        if(file.buffer instanceof ArrayBuffer)
        {
            var buffer = new SyncBuffer(file.buffer);
            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(file.buffer instanceof File)
        {
            // SyncFileBuffer:
            // - loads the whole disk image into memory, impossible for large files (more than 1GB)
            // - can later serve get/set operations fast and synchronously 
            // - takes some time for first load, neglectable for small files (up to 100Mb)
            //
            // AsyncFileBuffer:
            // - loads slices of the file asynchronously as requested
            // - slower get/set

            // Heuristics: If file is smaller than 16M, use SyncFileBuffer
            if(file.async === undefined)
            {
                file.async = file.buffer.size < 16 * 1024 * 1024;
            }

            if(file.async)
            {
                var buffer = new v86util.SyncFileBuffer(file.buffer);
            }
            else
            {
                var buffer = new v86util.AsyncFileBuffer(file.buffer);
            }

            files_to_load.push({
                name: name,
                loadable: buffer,
            });
        }
        else if(file.url)
        {
            if(file.async)
            {
                var buffer = new v86util.AsyncXHRBuffer(file.url, file.size);
                files_to_load.push({
                    name: name,
                    loadable: buffer,
                });
            }
            else
            {
                files_to_load.push({
                    name: name,
                    url: file.url,
                    size: file.size,
                });
            }
        }
        else
        {
            dbg_log("Ignored file: url=" + file.url + " buffer=" + file.buffer);
        }
    }

    var image_names = [
        "bios", "vga_bios", 
        "cdrom", "hda", "hdb", "fda", "fdb",
        "initial_state",
    ];

    for(var i = 0; i < image_names.length; i++)
    {
        add_file(image_names[i], options[image_names[i]]);
    }

    if(options["filesystem"])
    {
        var fs_url = options["filesystem"]["basefs"];
        var base_url = options["filesystem"]["baseurl"];

        this.fs9p = new FS(base_url);
        settings.fs9p = this.fs9p;

        if(fs_url)
        {
            console.assert(base_url, "Filesystem: baseurl must be specified");

            files_to_load.push({
                name: "fs9p_json",
                url: fs_url,
                as_text: true,
            });
        }
    }

    var starter = this;
    var total = files_to_load.length;

    cont(0);

    function cont(index)
    {
        if(index === total)
        {
            done();
            return;
        }

        var f = files_to_load[index];

        if(f.loadable)
        {
            f.loadable.onload = function(e)
            {
                put_on_settings(f.name, f.loadable);
                cont(index + 1);
            }
            f.loadable.load();
        }
        else
        {
            v86util.load_file(f.url, {
                done: function done(result)
                {
                    put_on_settings(f.name, new SyncBuffer(result));
                    cont(index + 1);
                },
                progress: function progress(e)
                {
                    starter.emulator_bus.send("download-progress", {
                        file_index: index,
                        file_count: total,

                        lengthComputable: e.lengthComputable,
                        total: f.size || e.total,
                        loaded: e.loaded,
                    });
                },
                as_text: f.as_text,
            });
        }
    }

    function done()
    {
        emulator.init(settings);

        if(settings.initial_state)
        {
            emulator.restore_state(settings.initial_state);
        }

        if(settings.fs9p)
        {
            settings.fs9p.OnJSONLoaded(settings.fs9p_json);
        }

        if(options["autostart"])
        {
            emulator.run();
        }
    }
}

/**
 * Start emulation. Do nothing if emulator is running already. Can be
 * asynchronous.
 */
V86Starter.prototype.run = function()
{
    this.v86.run();
};

/**
 * Stop emulation. Do nothing if emulator is not running. Can be asynchronous.
 */
V86Starter.prototype.stop = function()
{
    this.v86.stop();
};

/**
 * Restart (force a reboot).
 */
V86Starter.prototype.restart = function()
{
    this.v86.restart();
};

/**
 * Add an event listener (the emulator is an event emitter). A list of events
 * can be found at [events.md](events.md).
 *
 * The callback function gets a single argument which depends on the event.
 *
 * @param {string} event Name of the event.
 * @param {function(*)} listener The callback function. 
 */
V86Starter.prototype.add_listener = function(event, listener)
{
    this.bus.register(event, listener, this);
};

/**
 * Remove an event listener. 
 *
 * @param {string} event
 * @param {function(*)} listener
 */
V86Starter.prototype.remove_listener = function(event, listener)
{
    this.bus.unregister(event, listener);
};

/**
 * Restore the emulator state from the given state, which must be an
 * ArrayBuffer returned by
 * [`save_state`](#save_statefunctionobject-arraybuffer-callback). 
 *
 * Note that the state can only be restored correctly if this constructor has
 * been created with the same options as the original instance (e.g., same disk
 * images, memory size, etc.). 
 *
 * Different versions of the emulator might use a different format for the
 * state buffer.
 *
 * @param {ArrayBuffer} state
 */
V86Starter.prototype.restore_state = function(state)
{
    this.v86.restore_state(state);
};

/**
 * Asynchronously save the current state of the emulator. The first argument to
 * the callback is an Error object if something went wrong and is null
 * otherwise.
 *
 * @param {function(Object, ArrayBuffer)} callback
 */
V86Starter.prototype.save_state = function(callback)
{
    // Might become asynchronous at some point
    
    var emulator = this;

    setTimeout(function()
    {
        try
        {
            callback(null, emulator.v86.save_state());
        }
        catch(e)
        {
            callback(e, null);
        }
    }, 0);
};

/**
 * Return an object with several statistics. Return value looks similar to
 * (but can be subject to change in future versions or different
 * configurations, so use defensively):
 *
 * ```javascript
 * {
 *     "cpu": {
 *         "instruction_counter": 2821610069
 *     },
 *     "hda": {
 *         "sectors_read": 95240,
 *         "sectors_written": 952,
 *         "bytes_read": 48762880,
 *         "bytes_written": 487424,
 *         "loading": false
 *     },
 *     "cdrom": {
 *         "sectors_read": 0,
 *         "sectors_written": 0,
 *         "bytes_read": 0,
 *         "bytes_written": 0,
 *         "loading": false
 *     },
 *     "mouse": {
 *         "enabled": true
 *     },
 *     "vga": {
 *         "is_graphical": true,
 *         "res_x": 800,
 *         "res_y": 600,
 *         "bpp": 32
 *     }
 * }
 * ```
 *
 * @return {Object}
 */
V86Starter.prototype.get_statistics = function()
{
    var stats = {
        cpu: {
            instruction_counter: this.get_instruction_counter(),
        },
    };

    var devices = this.v86.cpu.devices;

    if(devices.hda)
    {
        stats.hda = devices.hda.stats;
    }

    if(devices.cdrom)
    {
        stats.cdrom = devices.cdrom.stats;
    }

    if(devices.ps2)
    {
        stats.mouse = {
            enabled: devices.ps2.use_mouse,
        };
    }

    if(devices.vga)
    {
        stats.vga = devices.vga.stats;
    }

    return stats;
};

/**
 * @return {number}
 * @ignore
 */
V86Starter.prototype.get_instruction_counter = function()
{
    return this.v86.cpu.timestamp_counter;
};

/**
 * @return {boolean}
 */
V86Starter.prototype.is_running = function()
{
    return this.v86.running;
};

/** 
 * Send a sequence of scan codes to the emulated PS2 controller. A list of
 * codes can be found at http://stanislavs.org/helppc/make_codes.html.
 * Do nothing if there is not keyboard controller.
 *
 * @param {Array.<number>} codes
 */
V86Starter.prototype.keyboard_send_scancodes = function(codes)
{
    var ps2 = this.v86.cpu.devices.ps2;

    for(var i = 0; i < codes.length; i++)
    {
        ps2.kbd_send_code(codes[i]);
    }
};

/**
 * Download a screenshot.
 * 
 * @ignore
 */
V86Starter.prototype.screen_make_screenshot = function()
{
    if(this.screen_adapter)
    {
        this.screen_adapter.make_screenshot();
    }
};

/**
 * Set the scaling level of the emulated screen.
 *
 * @param {number} sx
 * @param {number} sy
 *
 * @ignore
 */
V86Starter.prototype.screen_set_scale = function(sx, sy)
{
    if(this.screen_adapter)
    {
        this.screen_adapter.set_scale(sx, sy);
    }
};

/**
 * Go fullscreen.
 *
 * @ignore
 */
V86Starter.prototype.screen_go_fullscreen = function()
{
    if(!this.screen_adapter)
    {
        return;
    }

    var elem = document.getElementById("screen_container");

    if(!elem)
    {
        return;
    }

    // bracket notation because otherwise they get renamed by closure compiler
    var fn = elem["requestFullScreen"] || 
            elem["webkitRequestFullscreen"] || 
            elem["mozRequestFullScreen"] || 
            elem["msRequestFullScreen"];

    if(fn)
    {
        fn.call(elem);

        // This is necessary, because otherwise chromium keyboard doesn't work anymore.
        // Might (but doesn't seem to) break something else
        var focus_element = document.getElementsByClassName("phone_keyboard")[0];
        focus_element && focus_element.focus();
    }

    //this.lock_mouse(elem);
    this.lock_mouse();
};

/**
 * Lock the mouse cursor: It becomes invisble and is not moved out of the
 * browser window.
 *
 * @ignore
 */
V86Starter.prototype.lock_mouse = function()
{
    var elem = document.body;

    var fn = elem["requestPointerLock"] ||
                elem["mozRequestPointerLock"] ||
                elem["webkitRequestPointerLock"];

    if(fn)
    {
        fn.call(elem);
    }
};

/** 
 * Enable or disable sending mouse events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86Starter.prototype.mouse_set_status = function(enabled)
{
    if(this.mouse_adapter)
    {
        this.mouse_adapter.emu_enabled = enabled;
    }
};

/** 
 * Enable or disable sending keyboard events to the emulated PS2 controller.
 *
 * @param {boolean} enabled
 */
V86Starter.prototype.keyboard_set_status = function(enabled)
{
    if(this.keyboard_adapter)
    {
        this.keyboard_adapter.emu_enabled = enabled;
    }
};


/** 
 * Send a string to the first emulated serial terminal.
 *
 * @param {string} data
 */
V86Starter.prototype.serial0_send = function(data)
{
    for(var i = 0; i < data.length; i++)
    {
        this.bus.send("serial0-input", data.charCodeAt(i));
    }
};

/**
 * Write to a file in the 9p filesystem. Nothing happens if no filesystem has
 * been initialized. First argument to the callback is an error object if
 * something went wrong and null otherwise.
 *
 * @param {string} file
 * @param {Uint8Array} data
 * @param {function(Object)=} callback
 */
V86Starter.prototype.create_file = function(file, data, callback)
{
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var parts = file.split("/");
    var filename = parts[parts.length - 1];

    var path_infos = fs.SearchPath(file);
    var parent_id = path_infos.parentid;
    var not_found = filename === "" || parent_id === -1

    if(!not_found)
    {
        fs.CreateBinaryFile(filename, parent_id, data);
    }

    if(callback)
    {
        setTimeout(function()
        {
            if(not_found)
            {
                callback(new FileNotFoundError());
            }
            else
            {
                callback(null);
            }
        }, 0);
    }
};

/**
 * Read a file in the 9p filesystem. Nothing happens if no filesystem has been
 * initialized.
 *
 * @param {string} file
 * @param {function(Object, Uint8Array)} callback
 */
V86Starter.prototype.read_file = function(file, callback)
{
    var fs = this.fs9p;

    if(!fs)
    {
        return;
    }

    var path_infos = fs.SearchPath(file);
    var id = path_infos.id;

    if(id === -1)
    {
        callback(new FileNotFoundError(), null);
    }
    else
    {
        fs.OpenInode(id, undefined);
        fs.AddEvent(
            id, 
            function() 
            {
                callback(null, fs.inodedata[id]);
            }
        );
    }
};

/** 
 * @ignore
 * @constructor
 *
 * @param {string=} message
 */
function FileNotFoundError(message)
{
    this.message = message || "File not found";
}
FileNotFoundError.prototype = Error.prototype;

// Closure Compiler's way of exporting 
if(typeof window !== "undefined")
{
    window["V86Starter"] = V86Starter;
}
else if(typeof module !== "undefined" && typeof module.exports !== "undefined")
{
    module.exports["V86Starter"] = V86Starter;
}
else if(typeof importScripts === "function")
{
    // web worker
    self["V86Starter"] = V86Starter;
}

V86Starter.prototype["run"] = V86Starter.prototype.run;
V86Starter.prototype["stop"] = V86Starter.prototype.stop;
V86Starter.prototype["restart"] = V86Starter.prototype.restart;
V86Starter.prototype["add_listener"] = V86Starter.prototype.add_listener;
V86Starter.prototype["remove_listener"] = V86Starter.prototype.remove_listener;
V86Starter.prototype["restore_state"] = V86Starter.prototype.restore_state;
V86Starter.prototype["save_state"] = V86Starter.prototype.save_state;
V86Starter.prototype["get_statistics"] = V86Starter.prototype.get_statistics;
V86Starter.prototype["is_running"] = V86Starter.prototype.is_running;
V86Starter.prototype["keyboard_send_scancodes"] = V86Starter.prototype.keyboard_send_scancodes;
V86Starter.prototype["screen_make_screenshot"] = V86Starter.prototype.screen_make_screenshot;
V86Starter.prototype["screen_set_scale"] = V86Starter.prototype.screen_set_scale;
V86Starter.prototype["screen_go_fullscreen"] = V86Starter.prototype.screen_go_fullscreen;
V86Starter.prototype["lock_mouse"] = V86Starter.prototype.lock_mouse;
V86Starter.prototype["mouse_set_status"] = V86Starter.prototype.mouse_set_status;
V86Starter.prototype["keyboard_set_status"] = V86Starter.prototype.keyboard_set_status;
V86Starter.prototype["serial0_send"] = V86Starter.prototype.serial0_send;
V86Starter.prototype["create_file"] = V86Starter.prototype.create_file;
V86Starter.prototype["read_file"] = V86Starter.prototype.read_file;
