extends CharacterBody2D

const TILE_SIZE = 32
const MOVE_SPEED = 150.0

var is_moving = false
var target_position = Vector2()
var current_target_id = "" # שומר את המזהה של המפלצת שהשחקן סימן

var socket = WebSocketPeer.new()
const SERVER_URL = "ws://localhost:8080"

func _ready():
    target_position = position
    print("Connecting to server...")
    socket.connect_to_url(SERVER_URL)

func _process(_delta):
    socket.poll()
    var state = socket.get_ready_state()
    
    if state == WebSocketPeer.STATE_OPEN:
        while socket.get_available_packet_count():
            var packet = socket.get_packet().get_string_from_utf8()
            handle_server_message(packet)

# פונקציית לכידת לחיצות עכבר לבחירת מטרה (Targeting)
func _input(event):
    if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
        # במנוע אמיתי נעשה כאן Raycast כדי לבדוק על איזה מפלצת לחצנו.
        # לצורך האבטיפוס, נדמה שלחצנו על העכביש הראשון במפה.
        target_entity("mob_spider_1")

func target_entity(entity_id):
    if entity_id != current_target_id:
        current_target_id = entity_id
        if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
            var message = {
                "action": "attack",
                "target_id": entity_id
            }
            # שולחים בקשת התקפה לשרת. השרת ידאג לתת מכה אוטומטית כל 2 שניות אם נהיה קרובים.
            socket.send_text(JSON.stringify(message))
            print("Locked target on: ", entity_id)

func _physics_process(delta):
    if not is_moving:
        var input_dir = Vector2.ZERO
        
        if Input.is_action_pressed("ui_right"):
            input_dir.x = 1
        elif Input.is_action_pressed("ui_left"):
            input_dir.x = -1
        elif Input.is_action_pressed("ui_down"):
            input_dir.y = 1
        elif Input.is_action_pressed("ui_up"):
            input_dir.y = -1

        if input_dir != Vector2.ZERO:
            target_position = position + (input_dir * TILE_SIZE)
            is_moving = true
            send_move_request(target_position.x, target_position.y)
    else:
        position = position.move_toward(target_position, MOVE_SPEED * delta)
        if position == target_position:
            is_moving = false

func send_move_request(target_x, target_y):
    if socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
        var message = {
            "action": "move",
            "x": target_x,
            "y": target_y
        }
        socket.send_text(JSON.stringify(message))

func handle_server_message(data_string):
    var json = JSON.new()
    if json.parse(data_string) == OK:
        var data = json.data
        if data.has("action") and data["action"] == "force_position":
            position.x = data["x"]
            position.y = data["y"]
            target_position = position
            is_moving = false
