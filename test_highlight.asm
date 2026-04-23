    ; Test file for syntax highlighting
    
    ; Macro definitions
    Bank0To1 macro
        bsr     STATUS,6
        bsr     STATUS,5
    endm
    
    BANK3 macro
        bsr     STATUS,6
        bsr     STATUS,5
    endm
    
    ; cblock definition
    cblock  0x10
        temp2
        temp3
        temp4
        temp6
        temp5
    endc
    
    ; Test instructions
    movar   temp2
    movar   temp3
    movr    temp2,0
    xoria   ad10
    addar   ad10,1
    movia   setio
    movar   0x04
    movia   setio1
    movia   setio
    adcar   ad10,1
    ret
    retia   3
    retie
    
    ; Test macro calls
    Bank0To1
    BANK3
    