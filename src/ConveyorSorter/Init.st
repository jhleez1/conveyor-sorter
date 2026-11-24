(* Conveyor sorter - runs once when the PLC starts *)
PROGRAM _INIT

	State := STATE_IDLE;
	RedHead := 0;  RedCount := 0;
	BlueHead := 0; BlueCount := 0;
	RedParts := 0; BlueParts := 0; GreenParts := 0; DroppedParts := 0;

END_PROGRAM
